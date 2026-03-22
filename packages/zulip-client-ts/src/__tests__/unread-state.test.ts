import { describe, expect, test } from 'bun:test'
import type {
  EventId,
  MessageEvent,
  MessageId,
  StreamId,
  TopicName,
  UnixEpochSeconds,
  UnreadMsgs,
  UpdateMessageFlagsEvent,
  UserId,
} from 'zulip-ts'
import {
  applyFlagsEvent,
  applyMessageEvent,
  emptyUnreadState,
  getUnreadCount,
  getUnreadDmCount,
  getUnreadMessageIds,
  hasUnreadDms,
  hasUnreads,
  initUnreadState,
} from '../unread-state.ts'

// --- Helpers ---

function msgId(n: number): MessageId {
  return n as MessageId
}
function sid(n: number): StreamId {
  return n as StreamId
}
function uid(n: number): UserId {
  return n as UserId
}
function topic(s: string): TopicName {
  return s as TopicName
}
function eid(n: number): EventId {
  return n as EventId
}

function makeMessageEvent(overrides: {
  id?: number
  streamId?: number
  subject?: string
  msgId?: number
  senderId?: number
  type?: 'stream' | 'private'
  flags?: string[]
}): MessageEvent {
  const msgType = overrides.type ?? 'stream'
  const base = {
    id: msgId(overrides.msgId ?? 100),
    sender_id: uid(overrides.senderId ?? 1),
    sender_email: 'user@example.com' as never,
    sender_full_name: 'User' as never,
    content: 'hello',
    timestamp: 1000 as UnixEpochSeconds,
    reactions: [],
  }

  const message =
    msgType === 'stream'
      ? {
          ...base,
          type: 'stream' as const,
          stream_id: sid(overrides.streamId ?? 10),
          display_recipient: 'general' as never,
          subject: topic(overrides.subject ?? 'test-topic'),
        }
      : {
          ...base,
          type: 'private' as const,
          display_recipient: [
            {
              id: uid(overrides.senderId ?? 1),
              email: 'user@example.com' as never,
              full_name: 'User' as never,
            },
          ],
        }

  return {
    type: 'message',
    id: eid(overrides.id ?? 1),
    message,
    flags: overrides.flags ?? [],
  } as MessageEvent
}

function makeFlagsEvent(overrides: {
  id?: number
  op: 'add' | 'remove'
  flag: string
  messages: number[]
  all?: boolean
}): UpdateMessageFlagsEvent {
  return {
    type: 'update_message_flags',
    id: eid(overrides.id ?? 1),
    op: overrides.op,
    flag: overrides.flag,
    messages: overrides.messages.map(msgId),
    all: overrides.all ?? false,
  } as UpdateMessageFlagsEvent
}

// --- Tests ---

describe('initUnreadState', () => {
  test('parses stream unreads into nested map', () => {
    const unreadMsgs: UnreadMsgs = {
      count: 3,
      streams: [
        { stream_id: sid(10), topic: topic('bugs'), unread_message_ids: [msgId(1), msgId(2)] },
        { stream_id: sid(10), topic: topic('features'), unread_message_ids: [msgId(3)] },
      ],
      pms: [],
      mentions: [],
    }

    const state = initUnreadState(unreadMsgs)
    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(2)
    expect(getUnreadCount(state, sid(10), topic('features'))).toBe(1)
    expect(hasUnreads(state, sid(10), topic('bugs'))).toBe(true)
    expect(hasUnreads(state, sid(10), topic('nonexistent'))).toBe(false)
  })

  test('parses DM unreads', () => {
    const unreadMsgs: UnreadMsgs = {
      count: 2,
      streams: [],
      pms: [{ other_user_id: uid(5), unread_message_ids: [msgId(10), msgId(11)] }],
      mentions: [],
    }

    const state = initUnreadState(unreadMsgs)
    expect(getUnreadDmCount(state, uid(5))).toBe(2)
    expect(hasUnreadDms(state, uid(5))).toBe(true)
    expect(hasUnreadDms(state, uid(99))).toBe(false)
  })

  test('parses mentions', () => {
    const unreadMsgs: UnreadMsgs = {
      count: 1,
      streams: [],
      pms: [],
      mentions: [msgId(42)],
    }

    const state = initUnreadState(unreadMsgs)
    expect(state.mentions.has(msgId(42))).toBe(true)
  })
})

describe('emptyUnreadState', () => {
  test('all counts are zero', () => {
    const state = emptyUnreadState()
    expect(getUnreadCount(state, sid(1), topic('x'))).toBe(0)
    expect(getUnreadDmCount(state, uid(1))).toBe(0)
    expect(hasUnreads(state, sid(1), topic('x'))).toBe(false)
    expect(hasUnreadDms(state, uid(1))).toBe(false)
  })
})

describe('applyMessageEvent', () => {
  test('adds stream message to unread map', () => {
    const state = emptyUnreadState()
    const event = makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 1 })
    applyMessageEvent(state, event)

    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(1)
    expect(getUnreadMessageIds(state, sid(10), topic('bugs'))).toEqual([msgId(1)])
  })

  test('adds DM to unread map', () => {
    const state = emptyUnreadState()
    const event = makeMessageEvent({ type: 'private', senderId: 5, msgId: 20 })
    applyMessageEvent(state, event)

    expect(getUnreadDmCount(state, uid(5))).toBe(1)
  })

  test('skips messages already marked read', () => {
    const state = emptyUnreadState()
    const event = makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 1, flags: ['read'] })
    applyMessageEvent(state, event)

    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(0)
  })

  test('tracks mentions', () => {
    const state = emptyUnreadState()
    const event = makeMessageEvent({
      streamId: 10,
      subject: 'bugs',
      msgId: 1,
      flags: ['mentioned'],
    })
    applyMessageEvent(state, event)

    expect(state.mentions.has(msgId(1))).toBe(true)
  })

  test('tracks wildcard mentions', () => {
    const state = emptyUnreadState()
    const event = makeMessageEvent({
      streamId: 10,
      subject: 'bugs',
      msgId: 2,
      flags: ['wildcard_mentioned'],
    })
    applyMessageEvent(state, event)

    expect(state.mentions.has(msgId(2))).toBe(true)
  })

  test('accumulates multiple messages in same topic', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 1 }))
    applyMessageEvent(state, makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 2 }))
    applyMessageEvent(state, makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 3 }))

    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(3)
  })
})

describe('applyFlagsEvent', () => {
  test('removes specific messages when read flag added', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 1 }))
    applyMessageEvent(state, makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 2 }))

    applyFlagsEvent(state, makeFlagsEvent({ op: 'add', flag: 'read', messages: [1] }))
    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(1)
    expect(getUnreadMessageIds(state, sid(10), topic('bugs'))).toEqual([msgId(2)])
  })

  test('clears everything on mark-all-as-read', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 1 }))
    applyMessageEvent(state, makeMessageEvent({ type: 'private', senderId: 5, msgId: 20 }))

    applyFlagsEvent(state, makeFlagsEvent({ op: 'add', flag: 'read', messages: [], all: true }))
    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(0)
    expect(getUnreadDmCount(state, uid(5))).toBe(0)
  })

  test('removes read messages from DMs', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ type: 'private', senderId: 5, msgId: 20 }))
    applyMessageEvent(state, makeMessageEvent({ type: 'private', senderId: 5, msgId: 21 }))

    applyFlagsEvent(state, makeFlagsEvent({ op: 'add', flag: 'read', messages: [20] }))
    expect(getUnreadDmCount(state, uid(5))).toBe(1)
  })

  test('removes mentions when read', () => {
    const state = emptyUnreadState()
    applyMessageEvent(
      state,
      makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 1, flags: ['mentioned'] }),
    )
    expect(state.mentions.has(msgId(1))).toBe(true)

    applyFlagsEvent(state, makeFlagsEvent({ op: 'add', flag: 'read', messages: [1] }))
    expect(state.mentions.has(msgId(1))).toBe(false)
  })

  test('ignores non-read flag events', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 1 }))

    applyFlagsEvent(state, makeFlagsEvent({ op: 'add', flag: 'starred', messages: [1] }))
    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(1)
  })

  test('cleans up empty topic maps', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ streamId: 10, subject: 'bugs', msgId: 1 }))

    applyFlagsEvent(state, makeFlagsEvent({ op: 'add', flag: 'read', messages: [1] }))
    expect(state.streams.has(sid(10))).toBe(false)
  })
})

describe('getUnreadMessageIds', () => {
  test('returns empty array for unknown stream/topic', () => {
    const state = emptyUnreadState()
    expect(getUnreadMessageIds(state, sid(999), topic('nope'))).toEqual([])
  })
})
