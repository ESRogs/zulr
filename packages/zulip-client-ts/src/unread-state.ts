import type { Event, MessageId, StreamId, TopicName, UnreadMsgs, UserId } from 'zulip-ts'

export type UnreadState = {
  /** Nested map: streamId → topicName → set of unread message IDs. */
  readonly streams: Map<StreamId, Map<TopicName, Set<MessageId>>>
  /** Map: userId → set of unread DM message IDs from that user. */
  readonly dms: Map<UserId, Set<MessageId>>
  /** Set of message IDs where the user was mentioned. */
  readonly mentions: Set<MessageId>
}

/** Build initial unread state from the /register response's unread_msgs. */
export function initUnreadState(unreadMsgs: UnreadMsgs): UnreadState {
  const streams = new Map<StreamId, Map<TopicName, Set<MessageId>>>()
  for (const entry of unreadMsgs.streams) {
    let topicMap = streams.get(entry.stream_id)
    if (!topicMap) {
      topicMap = new Map()
      streams.set(entry.stream_id, topicMap)
    }
    topicMap.set(entry.topic, new Set(entry.unread_message_ids))
  }

  const dms = new Map<UserId, Set<MessageId>>()
  for (const entry of unreadMsgs.pms) {
    dms.set(entry.other_user_id, new Set(entry.unread_message_ids))
  }

  const mentions = new Set(unreadMsgs.mentions)

  return { streams, dms, mentions }
}

/** Create an empty unread state. */
export function emptyUnreadState(): UnreadState {
  return {
    streams: new Map(),
    dms: new Map(),
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
  } else {
    // DM — find the other user's ID
    // For DMs, sender_id is the other user (since the bot received it)
    const senderId = msg.sender_id
    let msgSet = state.dms.get(senderId)
    if (!msgSet) {
      msgSet = new Set()
      state.dms.set(senderId, msgSet)
    }
    msgSet.add(msg.id)
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
      state.dms.clear()
      state.mentions.clear()
      return
    }

    const messageIds = event.messages
    if (!messageIds || messageIds.length === 0) return

    const idsToRemove = new Set(messageIds)
    removeFromStreams(state.streams, idsToRemove)
    removeFromDms(state.dms, idsToRemove)
    for (const id of idsToRemove) {
      state.mentions.delete(id)
    }
  }
  // op === 'remove' (manually marking as unread) is rare and requires knowing
  // which stream/topic the messages belong to. Skip — state self-corrects on re-register.
}

function removeFromStreams(
  streams: Map<StreamId, Map<TopicName, Set<MessageId>>>,
  ids: Set<MessageId>,
): void {
  for (const [streamId, topicMap] of streams) {
    for (const [topic, msgSet] of topicMap) {
      for (const id of ids) {
        msgSet.delete(id)
      }
      if (msgSet.size === 0) topicMap.delete(topic)
    }
    if (topicMap.size === 0) streams.delete(streamId)
  }
}

function removeFromDms(dms: Map<UserId, Set<MessageId>>, ids: Set<MessageId>): void {
  for (const [userId, msgSet] of dms) {
    for (const id of ids) {
      msgSet.delete(id)
    }
    if (msgSet.size === 0) dms.delete(userId)
  }
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
