import { describe, expect, test } from 'bun:test'
import type {
  Event,
  EventId,
  MessageId,
  StreamId,
  TopicName,
  UnixEpochSeconds,
  UserId,
} from 'zulip-ts'
import { evaluateNotification } from '../notifications.ts'
import { applyUserTopicEvent, emptyTopicVisibility } from '../topic-visibility.ts'

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

function makeStreamMessageEvent(overrides: {
  streamId?: number
  subject?: string
  msgId?: number
  flags?: string[]
}): Event {
  return {
    type: 'message',
    id: eid(1),
    message: {
      id: msgId(overrides.msgId ?? 100),
      sender_id: uid(1),
      sender_email: 'user@example.com' as never,
      sender_full_name: 'User' as never,
      content: 'hello',
      timestamp: 1000 as UnixEpochSeconds,
      reactions: [],
      type: 'stream' as const,
      stream_id: sid(overrides.streamId ?? 10),
      display_recipient: 'general' as never,
      subject: topic(overrides.subject ?? 'test-topic'),
    },
    flags: overrides.flags ?? [],
  } as Event
}

function makeDmMessageEvent(overrides?: { flags?: string[] }): Event {
  return {
    type: 'message',
    id: eid(1),
    message: {
      id: msgId(100),
      sender_id: uid(1),
      sender_email: 'user@example.com' as never,
      sender_full_name: 'User' as never,
      content: 'hello',
      timestamp: 1000 as UnixEpochSeconds,
      reactions: [],
      type: 'private' as const,
      display_recipient: [
        { id: uid(1), email: 'user@example.com' as never, full_name: 'User' as never },
      ],
    },
    flags: overrides?.flags ?? [],
  } as Event
}

describe('evaluateNotification', () => {
  test('DMs always notify', () => {
    const tv = emptyTopicVisibility()
    const result = evaluateNotification(makeDmMessageEvent(), tv)
    expect(result.shouldNotify).toBe(true)
    expect(result.reason).toBe('dm')
  })

  test('@-mention notifies', () => {
    const tv = emptyTopicVisibility()
    const result = evaluateNotification(makeStreamMessageEvent({ flags: ['mentioned'] }), tv)
    expect(result.shouldNotify).toBe(true)
    expect(result.reason).toBe('mentioned')
  })

  test('wildcard mention notifies', () => {
    const tv = emptyTopicVisibility()
    const result = evaluateNotification(
      makeStreamMessageEvent({ flags: ['wildcard_mentioned'] }),
      tv,
    )
    expect(result.shouldNotify).toBe(true)
    expect(result.reason).toBe('wildcard_mentioned')
  })

  test('followed topic notifies', () => {
    const tv = emptyTopicVisibility()
    applyUserTopicEvent(tv, {
      type: 'user_topic',
      id: eid(1),
      stream_id: sid(10),
      topic_name: topic('test-topic'),
      visibility_policy: 3,
    } as unknown as Event)

    const result = evaluateNotification(
      makeStreamMessageEvent({ streamId: 10, subject: 'test-topic' }),
      tv,
    )
    expect(result.shouldNotify).toBe(true)
    expect(result.reason).toBe('followed_topic')
  })

  test('unfollowed topic is silent', () => {
    const tv = emptyTopicVisibility()
    const result = evaluateNotification(
      makeStreamMessageEvent({ streamId: 10, subject: 'test-topic' }),
      tv,
    )
    expect(result.shouldNotify).toBe(false)
    expect(result.reason).toBe('silent')
  })

  test('muted topic is silent even with no flags', () => {
    const tv = emptyTopicVisibility()
    applyUserTopicEvent(tv, {
      type: 'user_topic',
      id: eid(1),
      stream_id: sid(10),
      topic_name: topic('test-topic'),
      visibility_policy: 1,
    } as unknown as Event)

    const result = evaluateNotification(
      makeStreamMessageEvent({ streamId: 10, subject: 'test-topic' }),
      tv,
    )
    expect(result.shouldNotify).toBe(false)
    expect(result.reason).toBe('silent')
  })

  test('@-mention in muted topic still notifies', () => {
    const tv = emptyTopicVisibility()
    applyUserTopicEvent(tv, {
      type: 'user_topic',
      id: eid(1),
      stream_id: sid(10),
      topic_name: topic('test-topic'),
      visibility_policy: 1,
    } as unknown as Event)

    const result = evaluateNotification(
      makeStreamMessageEvent({ streamId: 10, subject: 'test-topic', flags: ['mentioned'] }),
      tv,
    )
    expect(result.shouldNotify).toBe(true)
    expect(result.reason).toBe('mentioned')
  })

  test('event without message is silent', () => {
    const tv = emptyTopicVisibility()
    const result = evaluateNotification({ type: 'message', id: eid(1) } as Event, tv)
    expect(result.shouldNotify).toBe(false)
    expect(result.reason).toBe('silent')
  })

  test('mention takes priority over followed topic', () => {
    const tv = emptyTopicVisibility()
    applyUserTopicEvent(tv, {
      type: 'user_topic',
      id: eid(1),
      stream_id: sid(10),
      topic_name: topic('test-topic'),
      visibility_policy: 3,
    } as unknown as Event)

    const result = evaluateNotification(
      makeStreamMessageEvent({ streamId: 10, subject: 'test-topic', flags: ['mentioned'] }),
      tv,
    )
    expect(result.shouldNotify).toBe(true)
    expect(result.reason).toBe('mentioned')
  })
})
