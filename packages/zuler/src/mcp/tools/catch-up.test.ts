import { expect, test } from 'bun:test'
import type { ChannelName, DisplayName, MessageId, TopicName, UnixEpochSeconds } from 'zulip-ts'
import type { FormattedMessage } from '../../zulip/message-reader.ts'
import { applyCatchUpFilters, computePerNarrowLimit } from './catch-up.ts'

const mid = (n: number) => n as MessageId
const ts = (n: number) => n as UnixEpochSeconds
const ch = (s: string) => s as ChannelName
const tp = (s: string) => s as TopicName
const dn = (s: string) => s as DisplayName

function streamMsg(id: number, timestamp: number, topic = 'a'): FormattedMessage {
  return {
    type: 'stream',
    id: mid(id),
    stream: ch('general'),
    topic: tp(topic),
    sender: dn('Alice'),
    content: 'hello',
    timestamp: ts(timestamp),
  }
}

function dmMsg(id: number, timestamp: number, isGroupDm = false): FormattedMessage {
  return {
    type: 'dm',
    id: mid(id),
    sender: dn('Alice'),
    content: 'hi',
    timestamp: ts(timestamp),
    dmWith: 'Bob',
    isGroupDm,
  }
}

// --- computePerNarrowLimit ---

test('computePerNarrowLimit returns 0 when there are no narrows', () => {
  expect(computePerNarrowLimit(50, 0)).toBe(0)
})

test('computePerNarrowLimit splits the maxMessages × 4 budget evenly across narrows', () => {
  expect(computePerNarrowLimit(50, 10)).toBe(20)
  expect(computePerNarrowLimit(50, 4)).toBe(50)
})

test('computePerNarrowLimit floor of 1 bites when narrowCount exceeds total budget', () => {
  // 1 × 4 = 4 budget over 1000 narrows = ceil(4/1000) = 1; floor of 1 holds.
  expect(computePerNarrowLimit(1, 1000)).toBe(1)
})

test('computePerNarrowLimit bounds total fetch for high-N agents', () => {
  // 100 narrows × 2 = 200 = maxMessages × 4 exactly (the intended cap).
  const perNarrow = computePerNarrowLimit(50, 100)
  expect(perNarrow).toBe(2)
  expect(perNarrow * 100).toBe(50 * 4)
})

test('computePerNarrowLimit scales with maxMessages', () => {
  expect(computePerNarrowLimit(100, 10)).toBe(40)
  expect(computePerNarrowLimit(10, 10)).toBe(4)
})

// --- applyCatchUpFilters ---

test('applyCatchUpFilters: empty input yields empty output', () => {
  const result = applyCatchUpFilters({ messages: [], cutoff: 0, maxMessages: 50 })
  expect(result.trimmed).toEqual([])
  expect(result.groupDmCount).toBe(0)
  expect(result.olderCount).toBe(0)
  expect(result.additionalInWindow).toBe(0)
  expect(result.trimmedZulipIds).toEqual([])
})

test('applyCatchUpFilters: group DMs are excluded and counted separately', () => {
  const messages = [
    streamMsg(1, 1000),
    dmMsg(2, 1100, true), // group DM
    streamMsg(3, 1200),
    dmMsg(4, 1300, false), // 1-on-1 DM stays
  ]
  const result = applyCatchUpFilters({ messages, cutoff: 0, maxMessages: 50 })
  expect(result.groupDmCount).toBe(1)
  expect(result.trimmed.map((m) => m.id)).toEqual([mid(1), mid(3), mid(4)])
})

test('applyCatchUpFilters: messages older than cutoff are excluded and counted', () => {
  const messages = [
    streamMsg(1, 500), // older
    streamMsg(2, 1500), // in window
    streamMsg(3, 800), // older
    streamMsg(4, 2000), // in window
  ]
  const result = applyCatchUpFilters({ messages, cutoff: 1000, maxMessages: 50 })
  expect(result.olderCount).toBe(2)
  expect(result.trimmed.map((m) => m.id)).toEqual([mid(2), mid(4)])
})

test('applyCatchUpFilters: trimmed slice keeps the newest, sorted oldest → newest', () => {
  const messages = [
    streamMsg(1, 1000),
    streamMsg(2, 3000),
    streamMsg(3, 2000),
    streamMsg(4, 4000),
    streamMsg(5, 5000),
  ]
  const result = applyCatchUpFilters({ messages, cutoff: 0, maxMessages: 3 })
  // Newest 3 by timestamp: ids 3 (2000), 2 (3000), 4 (4000), 5 (5000) — take last 3
  expect(result.trimmed.map((m) => m.id)).toEqual([mid(2), mid(4), mid(5)])
  expect(result.additionalInWindow).toBe(2)
})

test('applyCatchUpFilters: trimmedZulipIds filters out non-positive IDs', () => {
  // Inbox-only messages use negative IDs as placeholders (see inbox.ts)
  const messages = [
    streamMsg(1, 1000),
    { ...streamMsg(0, 1100), id: mid(-100) }, // inbox placeholder
    streamMsg(2, 1200),
    { ...streamMsg(0, 1300), id: mid(-200) },
  ]
  const result = applyCatchUpFilters({ messages, cutoff: 0, maxMessages: 50 })
  expect(result.trimmed).toHaveLength(4)
  expect(result.trimmedZulipIds).toEqual([mid(1), mid(2)])
})

test('applyCatchUpFilters: cutoff filter applies before group DM filter for olderCount', () => {
  // A group DM that's older than cutoff: it's removed by group DM filter, not counted as older.
  const messages = [
    dmMsg(1, 500, true), // group DM, older — excluded as group DM
    streamMsg(2, 600), // older
    streamMsg(3, 1500), // in window
  ]
  const result = applyCatchUpFilters({ messages, cutoff: 1000, maxMessages: 50 })
  expect(result.groupDmCount).toBe(1)
  expect(result.olderCount).toBe(1) // only the stream message
  expect(result.trimmed.map((m) => m.id)).toEqual([mid(3)])
})
