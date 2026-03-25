import type {
  EmojiName,
  Message,
  MessageId,
  Reaction,
  ReactionEvent,
  StreamId,
  TopicName,
  UserId,
} from 'zulip-ts'

/** Opaque key for a narrow — e.g. "stream:10:topic-name" or "dm:5". */
export type NarrowKey = string & { readonly __brand: 'NarrowKey' }

/** Construct a narrow key for a stream topic. */
export function streamNarrowKey(streamId: StreamId, topic: TopicName): NarrowKey {
  return `stream\0${streamId}\0${topic}` as NarrowKey
}

/** Construct a narrow key for a DM conversation with a user. */
export function dmNarrowKey(userId: UserId): NarrowKey {
  return `dm\0${userId}` as NarrowKey
}

type NarrowData = {
  /** Messages sorted by ID ascending. */
  messages: Message[]
  /** Reverse lookup for O(1) existence checks and deletion. */
  messageIds: Set<MessageId>
  hasFoundOldest: boolean
  hasFoundNewest: boolean
  /** Monotonically increasing counter for LRU tracking. */
  lastAccessed: number
}

export type MessageListDataCache = {
  readonly narrows: Map<NarrowKey, NarrowData>
  /** Global message index for O(1) lookup by ID across all narrows. */
  readonly messageIndex: Map<MessageId, Message>
  readonly maxNarrows: number
  accessCounter: number
}

const DEFAULT_MAX_NARROWS = 100

/** Create an empty message list data cache with LRU eviction. */
export function emptyMessageListDataCache(maxNarrows?: number): MessageListDataCache {
  return {
    narrows: new Map(),
    messageIndex: new Map(),
    maxNarrows: maxNarrows ?? DEFAULT_MAX_NARROWS,
    accessCounter: 0,
  }
}

function getOrCreateNarrow(cache: MessageListDataCache, key: NarrowKey): NarrowData {
  let data = cache.narrows.get(key)
  if (!data) {
    data = {
      messages: [],
      messageIds: new Set(),
      hasFoundOldest: false,
      hasFoundNewest: false,
      lastAccessed: ++cache.accessCounter,
    }
    cache.narrows.set(key, data)
    evictIfNeeded(cache)
  }
  return data
}

function touchNarrow(cache: MessageListDataCache, data: NarrowData): void {
  data.lastAccessed = ++cache.accessCounter
}

function evictIfNeeded(cache: MessageListDataCache): void {
  while (cache.narrows.size > cache.maxNarrows) {
    let oldestKey: NarrowKey | undefined
    let oldestAccess = Number.POSITIVE_INFINITY
    for (const [key, data] of cache.narrows) {
      if (data.lastAccessed < oldestAccess) {
        oldestAccess = data.lastAccessed
        oldestKey = key
      }
    }
    if (oldestKey) {
      const evicted = cache.narrows.get(oldestKey)
      if (evicted) {
        for (const id of evicted.messageIds) {
          cache.messageIndex.delete(id)
        }
      }
      cache.narrows.delete(oldestKey)
    } else {
      break
    }
  }
}

function insertSorted(cache: MessageListDataCache, data: NarrowData, msg: Message): void {
  if (data.messageIds.has(msg.id)) return // deduplicate
  data.messageIds.add(msg.id)
  cache.messageIndex.set(msg.id, msg)
  // Fast path: message is newest (common for event-delivered)
  if (data.messages.length === 0 || msg.id > data.messages[data.messages.length - 1].id) {
    data.messages.push(msg)
    return
  }
  // Binary search for insertion point
  let lo = 0
  let hi = data.messages.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (data.messages[mid].id < msg.id) lo = mid + 1
    else hi = mid
  }
  data.messages.splice(lo, 0, msg)
}

/** Add a message delivered via an event (extends the newest boundary). */
export function addEventMessage(cache: MessageListDataCache, key: NarrowKey, msg: Message): void {
  const data = getOrCreateNarrow(cache, key)
  insertSorted(cache, data, msg)
  data.hasFoundNewest = true
  touchNarrow(cache, data)
}

/**
 * Add messages fetched from the API.
 * Only caches results in two cases:
 * 1. Empty cache + foundNewest: true (the fetch includes the live tail)
 * 2. Existing cache with hasFoundNewest + contiguous fetch (extends backward)
 * All other cases: results are not cached (caller returns them directly).
 */
export function addApiMessages(
  cache: MessageListDataCache,
  key: NarrowKey,
  messages: readonly Message[],
  flags: { readonly foundOldest: boolean; readonly foundNewest: boolean },
): void {
  if (messages.length === 0) return

  const existing = cache.narrows.get(key)

  if (!existing || existing.messages.length === 0) {
    // Empty cache — only populate if the fetch includes the newest message
    if (!flags.foundNewest) return

    const data = existing ?? getOrCreateNarrow(cache, key)
    for (const msg of messages) {
      insertSorted(cache, data, msg)
    }
    if (flags.foundOldest) data.hasFoundOldest = true
    data.hasFoundNewest = true
    touchNarrow(cache, data)
    return
  }

  // Existing cache with messages — only merge if contiguous
  if (messages.length > 0) {
    const newestApiId = messages[messages.length - 1].id
    const oldestCachedId = existing.messages[0].id
    // Gap: newest API message is older than oldest cached and fetch didn't reach newest
    if (newestApiId < oldestCachedId && !flags.foundNewest) {
      return
    }
  }

  for (const msg of messages) {
    insertSorted(cache, existing, msg)
  }
  if (flags.foundOldest) existing.hasFoundOldest = true
  if (flags.foundNewest) existing.hasFoundNewest = true
  touchNarrow(cache, existing)
}

/**
 * Check if the cache can serve a request for `count` most-recent messages.
 * Returns true if:
 * - hasFoundNewest is true (we have the live tail), AND
 * - We have at least `count` messages, OR hasFoundOldest is true
 */
export function canServeFromCache(
  cache: MessageListDataCache,
  key: NarrowKey,
  count: number,
): boolean {
  const data = cache.narrows.get(key)
  if (!data) return false
  if (count <= 0) return true
  if (!data.hasFoundNewest) return false
  if (data.hasFoundOldest) return true
  return data.messages.length >= count
}

/**
 * Get up to `count` most-recent messages from the cache, sorted by ID ascending.
 * Returns an empty array if the narrow is not cached.
 */
export function getMessages(
  cache: MessageListDataCache,
  key: NarrowKey,
  count: number,
): readonly Message[] {
  const data = cache.narrows.get(key)
  if (!data || data.messages.length === 0) return []
  touchNarrow(cache, data)
  if (count >= data.messages.length) return [...data.messages]
  return data.messages.slice(-count)
}

/** Look up a message by ID across all narrows. */
export function getMessage(cache: MessageListDataCache, id: MessageId): Message | undefined {
  return cache.messageIndex.get(id)
}

/** Evict multiple messages from a narrow (e.g. on update_message content edit or topic move). */
export function evictMessages(
  cache: MessageListDataCache,
  key: NarrowKey,
  messageIds: readonly MessageId[],
): void {
  const data = cache.narrows.get(key)
  if (!data) return
  for (const id of messageIds) {
    if (!data.messageIds.has(id)) continue
    data.messageIds.delete(id)
    cache.messageIndex.delete(id)
    const idx = data.messages.findIndex((m) => m.id === id)
    if (idx !== -1) data.messages.splice(idx, 1)
  }
}

/** Remove a message from a narrow (e.g. on delete_message event). */
export function deleteMessage(
  cache: MessageListDataCache,
  key: NarrowKey,
  messageId: MessageId,
): void {
  const data = cache.narrows.get(key)
  if (!data) return
  if (!data.messageIds.has(messageId)) return
  data.messageIds.delete(messageId)
  cache.messageIndex.delete(messageId)
  const idx = data.messages.findIndex((m) => m.id === messageId)
  if (idx !== -1) data.messages.splice(idx, 1)
}

/** Update message content in-place for all cached copies. No-op if the message is not cached. */
export function updateMessageContent(
  cache: MessageListDataCache,
  messageId: MessageId,
  content: string,
): void {
  const msg = cache.messageIndex.get(messageId)
  if (!msg) return
  const mutable = msg as { content: string }
  mutable.content = content
}

/** Apply a reaction event to a cached message. No-op if the message is not cached. */
export function applyReactionEvent(cache: MessageListDataCache, event: ReactionEvent): void {
  const msg = cache.messageIndex.get(event.message_id)
  if (!msg) return
  if (event.op === 'add') {
    const already = msg.reactions.some(
      (r) => r.emoji_name === event.emoji_name && r.user_id === event.user_id,
    )
    if (!already) {
      msg.reactions.push({ emoji_name: event.emoji_name, user_id: event.user_id })
    }
  } else {
    const idx = msg.reactions.findIndex(
      (r) => r.emoji_name === event.emoji_name && r.user_id === event.user_id,
    )
    if (idx !== -1) msg.reactions.splice(idx, 1)
  }
}

/** Get reactions for a cached message. Returns empty array if message is not cached. */
export function getReactions(cache: MessageListDataCache, id: MessageId): readonly Reaction[] {
  return cache.messageIndex.get(id)?.reactions ?? []
}

/** Count reactions with a specific emoji on a cached message. */
export function getReactionCount(
  cache: MessageListDataCache,
  id: MessageId,
  emojiName: EmojiName,
): number {
  const msg = cache.messageIndex.get(id)
  if (!msg) return 0
  return msg.reactions.filter((r) => r.emoji_name === emojiName).length
}
