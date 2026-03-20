import { describe, expect, test } from 'bun:test'
import type { Event, EventId, StreamId, TopicName, UserTopicEntry } from 'zulip-ts'
import {
  applyUserTopicEvent,
  emptyTopicVisibility,
  getTopicVisibility,
  initTopicVisibility,
  isFollowed,
} from '../topic-visibility.ts'

function sid(n: number): StreamId {
  return n as StreamId
}
function topic(s: string): TopicName {
  return s as TopicName
}
function eid(n: number): EventId {
  return n as EventId
}

function makeUserTopicEvent(overrides: {
  streamId: number
  topicName: string
  visibilityPolicy: number
}): Event {
  return {
    type: 'user_topic',
    id: eid(1),
    stream_id: sid(overrides.streamId),
    topic_name: topic(overrides.topicName),
    visibility_policy: overrides.visibilityPolicy,
  } as unknown as Event
}

describe('initTopicVisibility', () => {
  test('builds state from user_topics entries', () => {
    const entries: UserTopicEntry[] = [
      { stream_id: sid(10), topic_name: topic('bugs'), visibility_policy: 3 },
      { stream_id: sid(10), topic_name: topic('features'), visibility_policy: 1 },
      { stream_id: sid(20), topic_name: topic('design'), visibility_policy: 2 },
    ]

    const state = initTopicVisibility(entries)
    expect(isFollowed(state, sid(10), topic('bugs'))).toBe(true)
    expect(getTopicVisibility(state, sid(10), topic('features'))).toBe(1)
    expect(getTopicVisibility(state, sid(20), topic('design'))).toBe(2)
  })

  test('skips INHERIT (0) entries', () => {
    const entries: UserTopicEntry[] = [
      { stream_id: sid(10), topic_name: topic('bugs'), visibility_policy: 0 },
    ]

    const state = initTopicVisibility(entries)
    expect(state.size).toBe(0)
  })

  test('handles empty entries', () => {
    const state = initTopicVisibility([])
    expect(state.size).toBe(0)
  })
})

describe('topic visibility', () => {
  test('defaults to INHERIT (0) for unknown topics', () => {
    const state = emptyTopicVisibility()
    expect(getTopicVisibility(state, sid(10), topic('bugs'))).toBe(0)
    expect(isFollowed(state, sid(10), topic('bugs'))).toBe(false)
  })

  test('sets visibility from user_topic event', () => {
    const state = emptyTopicVisibility()
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 10, topicName: 'bugs', visibilityPolicy: 3 }),
    )

    expect(getTopicVisibility(state, sid(10), topic('bugs'))).toBe(3)
    expect(isFollowed(state, sid(10), topic('bugs'))).toBe(true)
  })

  test('updates visibility on subsequent events', () => {
    const state = emptyTopicVisibility()
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 10, topicName: 'bugs', visibilityPolicy: 3 }),
    )
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 10, topicName: 'bugs', visibilityPolicy: 1 }),
    )

    expect(getTopicVisibility(state, sid(10), topic('bugs'))).toBe(1)
    expect(isFollowed(state, sid(10), topic('bugs'))).toBe(false)
  })

  test('INHERIT (0) removes the override', () => {
    const state = emptyTopicVisibility()
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 10, topicName: 'bugs', visibilityPolicy: 3 }),
    )
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 10, topicName: 'bugs', visibilityPolicy: 0 }),
    )

    expect(getTopicVisibility(state, sid(10), topic('bugs'))).toBe(0)
    // Stream entry cleaned up
    expect(state.has(sid(10))).toBe(false)
  })

  test('handles multiple topics per stream', () => {
    const state = emptyTopicVisibility()
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 10, topicName: 'bugs', visibilityPolicy: 3 }),
    )
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 10, topicName: 'features', visibilityPolicy: 1 }),
    )

    expect(isFollowed(state, sid(10), topic('bugs'))).toBe(true)
    expect(getTopicVisibility(state, sid(10), topic('features'))).toBe(1)
  })

  test('handles multiple streams', () => {
    const state = emptyTopicVisibility()
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 10, topicName: 'bugs', visibilityPolicy: 3 }),
    )
    applyUserTopicEvent(
      state,
      makeUserTopicEvent({ streamId: 20, topicName: 'bugs', visibilityPolicy: 2 }),
    )

    expect(isFollowed(state, sid(10), topic('bugs'))).toBe(true)
    expect(isFollowed(state, sid(20), topic('bugs'))).toBe(false)
    expect(getTopicVisibility(state, sid(20), topic('bugs'))).toBe(2)
  })

  test('ignores non-user_topic events', () => {
    const state = emptyTopicVisibility()
    applyUserTopicEvent(state, { type: 'message', id: eid(1) } as Event)

    expect(state.size).toBe(0)
  })
})
