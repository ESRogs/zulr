import { describe, expect, test } from 'bun:test'
import type {
  ChannelName,
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
  addMessage,
  applyDeleteMessageEvent,
  applyMessageEvent,
  applyUpdateMessageEvent,
  emptyMessageCache,
  getMessage,
  getTopicMessages,
  removeMessage,
} from '../message-cache.ts'

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

function makeStreamMessage(overrides: {
  id: number
  streamId?: number
  subject?: string
  content?: string
}) {
  return {
    id: msgId(overrides.id),
    type: 'stream' as const,
    stream_id: sid(overrides.streamId ?? 10),
    display_recipient: 'general' as ChannelName,
    subject: topic(overrides.subject ?? 'test-topic'),
    sender_id: uid(1),
    sender_email: 'user@example.com' as never,
    sender_full_name: 'User' as never,
    content: overrides.content ?? 'hello',
    timestamp: 1000 as UnixEpochSeconds,
    reactions: [],
  }
}

function makeDmMessage(overrides: { id: number; senderId?: number }) {
  return {
    id: msgId(overrides.id),
    type: 'private' as const,
    display_recipient: [
      {
        id: uid(overrides.senderId ?? 1),
        email: 'user@example.com' as never,
        full_name: 'User' as never,
      },
    ],
    sender_id: uid(overrides.senderId ?? 1),
    sender_email: 'user@example.com' as never,
    sender_full_name: 'User' as never,
    content: 'dm content',
    timestamp: 1000 as UnixEpochSeconds,
    reactions: [],
  }
}

describe('addMessage / getMessage', () => {
  test('stores and retrieves a stream message', () => {
    const cache = emptyMessageCache()
    const msg = makeStreamMessage({ id: 1 })
    addMessage(cache, msg)
    expect(getMessage(cache, msgId(1))).toBe(msg)
  })

  test('stores and retrieves a DM', () => {
    const cache = emptyMessageCache()
    const msg = makeDmMessage({ id: 5 })
    addMessage(cache, msg)
    expect(getMessage(cache, msgId(5))).toBe(msg)
  })

  test('returns undefined for missing message', () => {
    const cache = emptyMessageCache()
    expect(getMessage(cache, msgId(999))).toBeUndefined()
  })
})

describe('stream index', () => {
  test('indexes stream messages by stream and topic', () => {
    const cache = emptyMessageCache()
    addMessage(cache, makeStreamMessage({ id: 1, streamId: 10, subject: 'bugs' }))
    addMessage(cache, makeStreamMessage({ id: 2, streamId: 10, subject: 'bugs' }))
    addMessage(cache, makeStreamMessage({ id: 3, streamId: 10, subject: 'features' }))

    const bugs = getTopicMessages(cache, sid(10), topic('bugs'))
    expect(bugs.map((m) => m.id)).toEqual([msgId(1), msgId(2)])

    const features = getTopicMessages(cache, sid(10), topic('features'))
    expect(features.map((m) => m.id)).toEqual([msgId(3)])
  })

  test('returns sorted by ID', () => {
    const cache = emptyMessageCache()
    addMessage(cache, makeStreamMessage({ id: 3 }))
    addMessage(cache, makeStreamMessage({ id: 1 }))
    addMessage(cache, makeStreamMessage({ id: 2 }))

    const msgs = getTopicMessages(cache, sid(10), topic('test-topic'))
    expect(msgs.map((m) => m.id)).toEqual([msgId(1), msgId(2), msgId(3)])
  })

  test('returns empty array for unknown topic', () => {
    const cache = emptyMessageCache()
    expect(getTopicMessages(cache, sid(99), topic('nope'))).toEqual([])
  })
})

describe('removeMessage', () => {
  test('removes from messages map and stream index', () => {
    const cache = emptyMessageCache()
    addMessage(cache, makeStreamMessage({ id: 1, streamId: 10, subject: 'bugs' }))
    addMessage(cache, makeStreamMessage({ id: 2, streamId: 10, subject: 'bugs' }))

    removeMessage(cache, msgId(1))
    expect(getMessage(cache, msgId(1))).toBeUndefined()
    expect(getTopicMessages(cache, sid(10), topic('bugs')).map((m) => m.id)).toEqual([msgId(2)])
  })

  test('cleans up empty topic and stream entries', () => {
    const cache = emptyMessageCache()
    addMessage(cache, makeStreamMessage({ id: 1, streamId: 10, subject: 'bugs' }))

    removeMessage(cache, msgId(1))
    expect(cache.streamIndex.has(sid(10))).toBe(false)
  })

  test('no-ops for missing message', () => {
    const cache = emptyMessageCache()
    removeMessage(cache, msgId(999)) // should not throw
  })

  test('removes DM without affecting stream index', () => {
    const cache = emptyMessageCache()
    addMessage(cache, makeDmMessage({ id: 5 }))
    removeMessage(cache, msgId(5))
    expect(getMessage(cache, msgId(5))).toBeUndefined()
  })
})

describe('applyMessageEvent', () => {
  test('caches message from event', () => {
    const cache = emptyMessageCache()
    const msg = makeStreamMessage({ id: 1 })
    const event = { type: 'message', id: eid(1), message: msg, flags: [] } as MessageEvent
    applyMessageEvent(cache, event)
    expect(getMessage(cache, msgId(1))).toBe(msg)
  })
})

describe('applyUpdateMessageEvent', () => {
  test('evicts affected messages from cache', () => {
    const cache = emptyMessageCache()
    addMessage(cache, makeStreamMessage({ id: 1, subject: 'old-topic' }))
    addMessage(cache, makeStreamMessage({ id: 2, subject: 'old-topic' }))
    addMessage(cache, makeStreamMessage({ id: 3, subject: 'other' }))

    const event = {
      type: 'update_message',
      id: eid(1),
      message_id: msgId(1),
      message_ids: [msgId(1), msgId(2)],
      subject: topic('new-topic'),
      orig_subject: topic('old-topic'),
      stream_id: sid(10),
    } as UpdateMessageEvent

    applyUpdateMessageEvent(cache, event)
    expect(getMessage(cache, msgId(1))).toBeUndefined()
    expect(getMessage(cache, msgId(2))).toBeUndefined()
    expect(getMessage(cache, msgId(3))).toBeDefined()
  })
})

describe('applyDeleteMessageEvent', () => {
  test('removes message from cache', () => {
    const cache = emptyMessageCache()
    addMessage(cache, makeStreamMessage({ id: 1 }))

    const event = {
      type: 'delete_message',
      id: eid(1),
      message_id: msgId(1),
      message_type: 'stream',
      stream_id: sid(10),
      topic: topic('test-topic'),
    } as DeleteMessageEvent

    applyDeleteMessageEvent(cache, event)
    expect(getMessage(cache, msgId(1))).toBeUndefined()
  })
})
