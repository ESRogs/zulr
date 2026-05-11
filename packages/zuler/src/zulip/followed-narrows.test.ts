import { expect, test } from 'bun:test'
import type { FollowedTopic, ZulipSession } from 'zulip-client-ts'
import type { StreamId, TopicName } from 'zulip-ts'
import { buildFollowedNarrowGroups, buildFollowedNarrows } from './followed-narrows.ts'

const sid = (n: number) => n as StreamId
const tp = (s: string) => s as TopicName

function fakeSession(overrides: {
  followedTopics: readonly FollowedTopic[]
  hasUnreads: (streamId: StreamId, topic: TopicName) => boolean
  hasAnyUnreadMentions?: boolean
  hasAnyUnreadDms?: boolean
}): ZulipSession {
  return {
    getFollowedTopics: () => overrides.followedTopics,
    hasUnreads: overrides.hasUnreads,
    hasAnyUnreadMentions: () => overrides.hasAnyUnreadMentions ?? false,
    hasAnyUnreadDms: () => overrides.hasAnyUnreadDms ?? false,
  } as unknown as ZulipSession
}

test('unreadOnly: true filters out topics without unreads', () => {
  const session = fakeSession({
    followedTopics: [
      { streamId: sid(1), topic: tp('a') },
      { streamId: sid(1), topic: tp('b') },
      { streamId: sid(2), topic: tp('c') },
    ],
    hasUnreads: (s, t) => !(s === sid(1) && t === tp('b')), // 'b' has no unreads
    hasAnyUnreadMentions: false,
    hasAnyUnreadDms: false,
  })

  const result = buildFollowedNarrowGroups(session, {
    unreadOnly: true,
    resolveChannelName: (s) => `chan-${s}`,
  })

  expect(result.skippedNoUnreads).toBe(1)
  expect(result.channelCount).toBe(2)
  const topicNarrows = result.groups.flatMap((g) => g.narrows)
  expect(topicNarrows).toHaveLength(2)
  // Every narrow should include the is:unread filter
  for (const n of topicNarrows) {
    expect(n.some((f) => f.operator === 'is' && f.operand === 'unread')).toBe(true)
  }
})

test('unreadOnly: false keeps all followed topics and omits is:unread', () => {
  const session = fakeSession({
    followedTopics: [
      { streamId: sid(1), topic: tp('a') },
      { streamId: sid(2), topic: tp('c') },
    ],
    hasUnreads: () => false, // would be filtered in unreadOnly mode
  })

  const result = buildFollowedNarrowGroups(session, {
    unreadOnly: false,
    resolveChannelName: (s) => `chan-${s}`,
  })

  expect(result.skippedNoUnreads).toBe(0)
  expect(result.channelCount).toBe(2)
  const topicNarrows = result.groups
    .filter((g) => g.narrows.some((n) => n.some((f) => f.operator === 'stream')))
    .flatMap((g) => g.narrows)
  expect(topicNarrows).toHaveLength(2)
  for (const n of topicNarrows) {
    expect(n.some((f) => f.operator === 'is' && f.operand === 'unread')).toBe(false)
  }
})

test('unreadOnly: true skips mentions group when no unread mentions', () => {
  const session = fakeSession({
    followedTopics: [],
    hasUnreads: () => false,
    hasAnyUnreadMentions: false,
    hasAnyUnreadDms: true,
  })

  const result = buildFollowedNarrowGroups(session, {
    unreadOnly: true,
    resolveChannelName: () => undefined,
  })

  const labels = result.groups.map((g) => g.label)
  expect(labels).toContain('DMs')
  expect(labels).not.toContain('mentions')
})

test('unreadOnly: false always includes mentions and DMs groups', () => {
  const session = fakeSession({
    followedTopics: [],
    hasUnreads: () => false,
    hasAnyUnreadMentions: false,
    hasAnyUnreadDms: false,
  })

  const result = buildFollowedNarrowGroups(session, {
    unreadOnly: false,
    resolveChannelName: () => undefined,
  })

  const labels = result.groups.map((g) => g.label)
  expect(labels).toContain('DMs')
  expect(labels).toContain('mentions')
})

test('groups topics by channel and labels with resolved name', () => {
  const session = fakeSession({
    followedTopics: [
      { streamId: sid(1), topic: tp('a') },
      { streamId: sid(1), topic: tp('b') },
      { streamId: sid(2), topic: tp('c') },
    ],
    hasUnreads: () => true,
  })

  const result = buildFollowedNarrowGroups(session, {
    unreadOnly: true,
    resolveChannelName: (s) => (s === sid(1) ? 'general' : undefined),
  })

  const topicGroups = result.groups.filter((g) =>
    g.narrows.some((n) => n.some((f) => f.operator === 'stream')),
  )
  expect(topicGroups).toHaveLength(2)
  const generalGroup = topicGroups.find((g) => g.label.includes('general'))
  expect(generalGroup?.label).toBe('2 topic(s) in general')
  const fallbackGroup = topicGroups.find((g) => g.label.includes('channel 2'))
  expect(fallbackGroup?.label).toBe('1 topic(s) in channel 2')
})

test('topic narrow uses streamId in stream operator', () => {
  const session = fakeSession({
    followedTopics: [{ streamId: sid(42), topic: tp('hello') }],
    hasUnreads: () => true,
  })

  const result = buildFollowedNarrowGroups(session, {
    unreadOnly: true,
    resolveChannelName: () => undefined,
  })

  const narrow = result.groups[0]!.narrows[0]!
  const streamFilter = narrow.find((f) => f.operator === 'stream')
  expect(streamFilter?.operand).toBe(sid(42))
  const topicFilter = narrow.find((f) => f.operator === 'topic')
  expect(topicFilter?.operand).toBe(tp('hello'))
})

test('buildFollowedNarrows returns flat narrows with topic counts', () => {
  const session = fakeSession({
    followedTopics: [
      { streamId: sid(1), topic: tp('a') },
      { streamId: sid(1), topic: tp('b') },
      { streamId: sid(2), topic: tp('c') },
    ],
    hasUnreads: () => true,
    hasAnyUnreadMentions: true,
    hasAnyUnreadDms: true,
  })

  const result = buildFollowedNarrows(session, { unreadOnly: true })

  expect(result.topicCount).toBe(3)
  expect(result.channelCount).toBe(2)
  expect(result.skippedNoUnreads).toBe(0)
  // 3 topics + mentions + DMs = 5 narrows
  expect(result.narrows).toHaveLength(5)
  // All include is:unread when unreadOnly
  for (const n of result.narrows) {
    expect(n.some((f) => f.operator === 'is' && f.operand === 'unread')).toBe(true)
  }
})

test('buildFollowedNarrows respects unreadOnly skip rules', () => {
  const session = fakeSession({
    followedTopics: [
      { streamId: sid(1), topic: tp('a') },
      { streamId: sid(2), topic: tp('b') },
    ],
    hasUnreads: (s) => s === sid(1), // only s=1 has unreads
    hasAnyUnreadMentions: false,
    hasAnyUnreadDms: false,
  })

  const result = buildFollowedNarrows(session, { unreadOnly: true })

  expect(result.topicCount).toBe(1)
  expect(result.skippedNoUnreads).toBe(1)
  // Only the s=1 topic narrow, no mentions or DMs (no unreads)
  expect(result.narrows).toHaveLength(1)
})

test('buildFollowedNarrows in unreadOnly: false includes all narrows without is:unread', () => {
  const session = fakeSession({
    followedTopics: [{ streamId: sid(1), topic: tp('a') }],
    hasUnreads: () => false,
  })

  const result = buildFollowedNarrows(session, { unreadOnly: false })

  // 1 topic + mentions + DMs = 3 narrows, none with is:unread
  expect(result.narrows).toHaveLength(3)
  for (const n of result.narrows) {
    expect(n.some((f) => f.operator === 'is' && f.operand === 'unread')).toBe(false)
  }
})
