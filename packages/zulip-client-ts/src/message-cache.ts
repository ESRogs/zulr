import type {
  DeleteMessageEvent,
  Message,
  MessageEvent,
  MessageId,
  StreamId,
  TopicName,
  UpdateMessageEvent,
} from 'zulip-ts'

export type MessageCache = {
  /** All cached messages by ID. */
  readonly messages: Map<MessageId, Message>
  /** Stream index: streamId → topicName → set of message IDs. */
  readonly streamIndex: Map<StreamId, Map<TopicName, Set<MessageId>>>
}

export function emptyMessageCache(): MessageCache {
  return {
    messages: new Map(),
    streamIndex: new Map(),
  }
}

/** Add a message to the cache. */
export function addMessage(cache: MessageCache, msg: Message): void {
  cache.messages.set(msg.id, msg)
  if (msg.type === 'stream') {
    let topicMap = cache.streamIndex.get(msg.stream_id)
    if (!topicMap) {
      topicMap = new Map()
      cache.streamIndex.set(msg.stream_id, topicMap)
    }
    let idSet = topicMap.get(msg.subject)
    if (!idSet) {
      idSet = new Set()
      topicMap.set(msg.subject, idSet)
    }
    idSet.add(msg.id)
  }
}

/** Remove a message from the cache by ID. */
export function removeMessage(cache: MessageCache, id: MessageId): void {
  const msg = cache.messages.get(id)
  if (!msg) return
  cache.messages.delete(id)
  if (msg.type === 'stream') {
    const topicMap = cache.streamIndex.get(msg.stream_id)
    if (topicMap) {
      const idSet = topicMap.get(msg.subject)
      if (idSet) {
        idSet.delete(id)
        if (idSet.size === 0) topicMap.delete(msg.subject)
      }
      if (topicMap.size === 0) cache.streamIndex.delete(msg.stream_id)
    }
  }
}

/** Apply a message event — cache the new message. */
export function applyMessageEvent(cache: MessageCache, event: MessageEvent): void {
  addMessage(cache, event.message)
}

/**
 * Apply an update_message event — evict affected messages from cache.
 * Following the Zulip web app pattern: evict rather than surgically update.
 * The next `read` call will fetch fresh content from the API.
 */
export function applyUpdateMessageEvent(cache: MessageCache, event: UpdateMessageEvent): void {
  for (const id of event.message_ids) {
    removeMessage(cache, id)
  }
}

/** Apply a delete_message event — remove the message from cache. */
export function applyDeleteMessageEvent(cache: MessageCache, event: DeleteMessageEvent): void {
  removeMessage(cache, event.message_id)
}

/** Get a cached message by ID. */
export function getMessage(cache: MessageCache, id: MessageId): Message | undefined {
  return cache.messages.get(id)
}

/** Count of cached messages for a stream topic. */
export function getTopicMessageCount(
  cache: MessageCache,
  streamId: StreamId,
  topic: TopicName,
): number {
  return cache.streamIndex.get(streamId)?.get(topic)?.size ?? 0
}

/**
 * Get cached messages for a stream topic, sorted by ID (ascending).
 * Returns an empty array if no messages are cached for the topic.
 */
export function getTopicMessages(
  cache: MessageCache,
  streamId: StreamId,
  topic: TopicName,
): readonly Message[] {
  const idSet = cache.streamIndex.get(streamId)?.get(topic)
  if (!idSet || idSet.size === 0) return []
  const result: Message[] = []
  for (const id of idSet) {
    const msg = cache.messages.get(id)
    if (msg) result.push(msg)
  }
  return result.sort((a, b) => a.id - b.id)
}
