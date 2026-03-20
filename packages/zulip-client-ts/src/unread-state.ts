import type { Event, MessageId, StreamId, TopicName, UnreadMsgs, UserId } from 'zulip-ts'

type StreamLocation = { readonly streamId: StreamId; readonly topic: TopicName }

export type UnreadState = {
  /** Nested map: streamId → topicName → set of unread message IDs. */
  readonly streams: Map<StreamId, Map<TopicName, Set<MessageId>>>
  /** Reverse index: messageId → stream location. O(1) removal on read events. */
  readonly streamIndex: Map<MessageId, StreamLocation>
  /** Map: userId → set of unread DM message IDs from that user. */
  readonly dms: Map<UserId, Set<MessageId>>
  /** Reverse index: messageId → userId. O(1) removal on read events. */
  readonly dmIndex: Map<MessageId, UserId>
  /** Set of message IDs where the user was mentioned. */
  readonly mentions: Set<MessageId>
}

/** Build initial unread state from the /register response's unread_msgs. */
export function initUnreadState(unreadMsgs: UnreadMsgs): UnreadState {
  const streams = new Map<StreamId, Map<TopicName, Set<MessageId>>>()
  const streamIndex = new Map<MessageId, StreamLocation>()
  for (const entry of unreadMsgs.streams) {
    let topicMap = streams.get(entry.stream_id)
    if (!topicMap) {
      topicMap = new Map()
      streams.set(entry.stream_id, topicMap)
    }
    topicMap.set(entry.topic, new Set(entry.unread_message_ids))
    const loc: StreamLocation = { streamId: entry.stream_id, topic: entry.topic }
    for (const id of entry.unread_message_ids) {
      streamIndex.set(id, loc)
    }
  }

  const dms = new Map<UserId, Set<MessageId>>()
  const dmIndex = new Map<MessageId, UserId>()
  for (const entry of unreadMsgs.pms) {
    dms.set(entry.other_user_id, new Set(entry.unread_message_ids))
    for (const id of entry.unread_message_ids) {
      dmIndex.set(id, entry.other_user_id)
    }
  }

  const mentions = new Set(unreadMsgs.mentions)

  return { streams, streamIndex, dms, dmIndex, mentions }
}

/** Create an empty unread state. */
export function emptyUnreadState(): UnreadState {
  return {
    streams: new Map(),
    streamIndex: new Map(),
    dms: new Map(),
    dmIndex: new Map(),
    mentions: new Set(),
  }
}

/** Apply a message event — adds the message ID to the appropriate unread set. */
export function applyMessageEvent(state: UnreadState, event: Event): void {
  const msg = event.message
  if (!msg) return

  const flags = event.flags ?? []

  // If already marked read at delivery time, skip
  if (flags.includes('read')) return

  if (msg.type === 'stream') {
    let topicMap = state.streams.get(msg.stream_id)
    if (!topicMap) {
      topicMap = new Map()
      state.streams.set(msg.stream_id, topicMap)
    }
    let msgSet = topicMap.get(msg.subject)
    if (!msgSet) {
      msgSet = new Set()
      topicMap.set(msg.subject, msgSet)
    }
    msgSet.add(msg.id)
    state.streamIndex.set(msg.id, { streamId: msg.stream_id, topic: msg.subject })
  } else {
    // DM — sender_id is the other user (bot received it; own sends have flags: ['read'])
    const senderId = msg.sender_id
    let msgSet = state.dms.get(senderId)
    if (!msgSet) {
      msgSet = new Set()
      state.dms.set(senderId, msgSet)
    }
    msgSet.add(msg.id)
    state.dmIndex.set(msg.id, senderId)
  }

  // Track mentions
  if (flags.includes('mentioned') || flags.includes('wildcard_mentioned')) {
    state.mentions.add(msg.id)
  }
}

/** Apply an update_message_flags event — adds/removes read flags from unread sets. */
export function applyFlagsEvent(state: UnreadState, event: Event): void {
  if (event.flag !== 'read') return

  if (event.op === 'add') {
    // "Mark all as read" — clear everything
    if (event.all) {
      state.streams.clear()
      state.streamIndex.clear()
      state.dms.clear()
      state.dmIndex.clear()
      state.mentions.clear()
      return
    }

    const messageIds = event.messages
    if (!messageIds || messageIds.length === 0) return

    for (const id of messageIds) {
      // Remove from stream unreads via reverse index
      const loc = state.streamIndex.get(id)
      if (loc) {
        const topicMap = state.streams.get(loc.streamId)
        if (topicMap) {
          const msgSet = topicMap.get(loc.topic)
          if (msgSet) {
            msgSet.delete(id)
            if (msgSet.size === 0) topicMap.delete(loc.topic)
          }
          if (topicMap.size === 0) state.streams.delete(loc.streamId)
        }
        state.streamIndex.delete(id)
      }

      // Remove from DM unreads via reverse index
      const dmUserId = state.dmIndex.get(id)
      if (dmUserId !== undefined) {
        const msgSet = state.dms.get(dmUserId)
        if (msgSet) {
          msgSet.delete(id)
          if (msgSet.size === 0) state.dms.delete(dmUserId)
        }
        state.dmIndex.delete(id)
      }

      state.mentions.delete(id)
    }
  }
  // op === 'remove' (manually marking as unread) is rare and requires knowing
  // which stream/topic the messages belong to. Skip — state self-corrects on re-register.
}

// --- Query functions ---

export function getUnreadCount(state: UnreadState, streamId: StreamId, topic: TopicName): number {
  return state.streams.get(streamId)?.get(topic)?.size ?? 0
}

export function hasUnreads(state: UnreadState, streamId: StreamId, topic: TopicName): boolean {
  return getUnreadCount(state, streamId, topic) > 0
}

export function getUnreadMessageIds(
  state: UnreadState,
  streamId: StreamId,
  topic: TopicName,
): readonly MessageId[] {
  const set = state.streams.get(streamId)?.get(topic)
  return set ? [...set] : []
}

export function getUnreadDmCount(state: UnreadState, userId: UserId): number {
  return state.dms.get(userId)?.size ?? 0
}

export function hasUnreadDms(state: UnreadState, userId: UserId): boolean {
  return getUnreadDmCount(state, userId) > 0
}
