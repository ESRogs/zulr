import { describe, expect, test } from 'bun:test'
import type {
  DeleteMessageEvent,
  EventId,
  MessageEvent,
  MessageId,
  StreamId,
  TopicName,
  UnixEpochSeconds,
  UpdateMessageEvent,
  UserId,
} from 'zulip-ts'
import {
  applyDeleteMessageEvent,
  applyMessageEvent,
  applyUpdateMessageEvent,
  emptyUnreadState,
  getUnreadCount,
  getUnreadDmCount,
  hasUnreadDms,
  hasUnreads,
} from '../unread-state.ts'

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
  msgId: number
  streamId?: number
  subject?: string
  senderId?: number
  type?: 'stream' | 'private'
}): MessageEvent {
  const msgType = overrides.type ?? 'stream'
  const base = {
    id: msgId(overrides.msgId),
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

  return { type: 'message', id: eid(overrides.msgId), message, flags: [] } as MessageEvent
}

describe('applyUpdateMessageEvent (topic moves)', () => {
  test('moves unreads from old topic to new topic', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ msgId: 1, streamId: 10, subject: 'old' }))
    applyMessageEvent(state, makeMessageEvent({ msgId: 2, streamId: 10, subject: 'old' }))

    const event = {
      type: 'update_message',
      id: eid(100),
      message_id: msgId(1),
      message_ids: [msgId(1), msgId(2)],
      subject: topic('new'),
      orig_subject: topic('old'),
      stream_id: sid(10),
    } as UpdateMessageEvent

    applyUpdateMessageEvent(state, event)

    expect(getUnreadCount(state, sid(10), topic('old'))).toBe(0)
    expect(hasUnreads(state, sid(10), topic('old'))).toBe(false)
    expect(getUnreadCount(state, sid(10), topic('new'))).toBe(2)
  })

  test('moves only specified messages, leaves others in old topic', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ msgId: 1, streamId: 10, subject: 'old' }))
    applyMessageEvent(state, makeMessageEvent({ msgId: 2, streamId: 10, subject: 'old' }))
    applyMessageEvent(state, makeMessageEvent({ msgId: 3, streamId: 10, subject: 'old' }))

    const event = {
      type: 'update_message',
      id: eid(100),
      message_id: msgId(1),
      message_ids: [msgId(1), msgId(2)],
      subject: topic('new'),
      orig_subject: topic('old'),
      stream_id: sid(10),
    } as UpdateMessageEvent

    applyUpdateMessageEvent(state, event)

    expect(getUnreadCount(state, sid(10), topic('old'))).toBe(1)
    expect(getUnreadCount(state, sid(10), topic('new'))).toBe(2)
  })
})

describe('applyUpdateMessageEvent (stream moves)', () => {
  test('moves unreads from old stream to new stream', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ msgId: 1, streamId: 10, subject: 'topic-a' }))

    const event = {
      type: 'update_message',
      id: eid(100),
      message_id: msgId(1),
      message_ids: [msgId(1)],
      stream_id: sid(10),
      new_stream_id: sid(20),
      subject: topic('topic-a'),
      orig_subject: topic('topic-a'),
    } as UpdateMessageEvent

    applyUpdateMessageEvent(state, event)

    expect(getUnreadCount(state, sid(10), topic('topic-a'))).toBe(0)
    expect(getUnreadCount(state, sid(20), topic('topic-a'))).toBe(1)
  })

  test('handles combined stream and topic move', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ msgId: 1, streamId: 10, subject: 'old-topic' }))

    const event = {
      type: 'update_message',
      id: eid(100),
      message_id: msgId(1),
      message_ids: [msgId(1)],
      stream_id: sid(10),
      new_stream_id: sid(20),
      subject: topic('new-topic'),
      orig_subject: topic('old-topic'),
    } as UpdateMessageEvent

    applyUpdateMessageEvent(state, event)

    expect(getUnreadCount(state, sid(10), topic('old-topic'))).toBe(0)
    expect(getUnreadCount(state, sid(20), topic('new-topic'))).toBe(1)
  })
})

describe('applyUpdateMessageEvent (content-only edits)', () => {
  test('ignores content-only edits (no topic or stream change)', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ msgId: 1, streamId: 10, subject: 'bugs' }))

    const event = {
      type: 'update_message',
      id: eid(100),
      message_id: msgId(1),
      message_ids: [msgId(1)],
      content: 'edited content',
      orig_content: 'original content',
    } as UpdateMessageEvent

    applyUpdateMessageEvent(state, event)

    // Unread state unchanged
    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(1)
  })
})

describe('applyDeleteMessageEvent', () => {
  test('removes stream message from unreads', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ msgId: 1, streamId: 10, subject: 'bugs' }))
    applyMessageEvent(state, makeMessageEvent({ msgId: 2, streamId: 10, subject: 'bugs' }))

    const event = {
      type: 'delete_message',
      id: eid(100),
      message_id: msgId(1),
      message_type: 'stream',
      stream_id: sid(10),
      topic: topic('bugs'),
    } as DeleteMessageEvent

    applyDeleteMessageEvent(state, event)

    expect(getUnreadCount(state, sid(10), topic('bugs'))).toBe(1)
  })

  test('removes DM from unreads', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ type: 'private', msgId: 10, senderId: 5 }))

    const event = {
      type: 'delete_message',
      id: eid(100),
      message_id: msgId(10),
      message_type: 'private',
    } as DeleteMessageEvent

    applyDeleteMessageEvent(state, event)

    expect(getUnreadDmCount(state, uid(5))).toBe(0)
    expect(hasUnreadDms(state, uid(5))).toBe(false)
  })

  test('cleans up empty containers', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, makeMessageEvent({ msgId: 1, streamId: 10, subject: 'bugs' }))

    const event = {
      type: 'delete_message',
      id: eid(100),
      message_id: msgId(1),
      message_type: 'stream',
    } as DeleteMessageEvent

    applyDeleteMessageEvent(state, event)

    expect(state.streams.has(sid(10))).toBe(false)
    expect(state.streamIndex.has(msgId(1))).toBe(false)
  })

  test('removes from mentions', () => {
    const state = emptyUnreadState()
    applyMessageEvent(state, {
      type: 'message',
      id: eid(1),
      message: {
        id: msgId(1),
        type: 'stream',
        stream_id: sid(10),
        display_recipient: 'general' as never,
        subject: topic('bugs'),
        sender_id: uid(1),
        sender_email: 'u@e.com' as never,
        sender_full_name: 'U' as never,
        content: 'hi',
        timestamp: 1000 as never,
        reactions: [],
      },
      flags: ['mentioned'],
    } as MessageEvent)

    expect(state.mentions.has(msgId(1))).toBe(true)

    applyDeleteMessageEvent(state, {
      type: 'delete_message',
      id: eid(100),
      message_id: msgId(1),
      message_type: 'stream',
    } as DeleteMessageEvent)
    expect(state.mentions.has(msgId(1))).toBe(false)
  })
})
