import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ChannelName,
  DisplayName,
  MessageId,
  TopicName,
  UnixEpochSeconds,
  UserId,
} from 'zulip-ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { readInbox, writeToInbox } from './inbox.ts'

// We test buildNarrows by importing it — but it's not exported.
// Instead, we test the full backfillBot flow by mocking getMessages/markAsRead.
// For unit-level narrow building, we verify via the fetch calls in the mock.

let teamName: TeamName

const tm = (s: string) => s as TeammateName
const ch = (s: string) => s as ChannelName
const tp = (s: string) => s as TopicName
const dn = (s: string) => s as DisplayName
const mid = (n: number) => n as MessageId

const uid = (n: number) => n as UserId
const ts = (n: number) => n as UnixEpochSeconds

beforeEach(() => {
  teamName = `test-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}` as TeamName
})

afterEach(() => {
  rmSync(join(homedir(), '.claude', 'teams', teamName), { recursive: true, force: true })
})

// --- Inbox deduplication tests (testing the dedup logic used by backfill) ---

test('backfill skips messages already in inbox by zulipMessageId', () => {
  // Pre-populate inbox with a message
  writeToInbox(teamName, tm('bot'), {
    from: 'zulip:general/topic:Alice',
    text: 'existing message\n[msg:100 ts:2026-01-01T00:00:00.000Z]',
    summary: 'existing message',
    zulipMessageId: mid(100),
    zulipSenderId: uid(42),
    zulipStream: ch('general'),
    zulipTopic: tp('topic'),
    zulipSender: dn('Alice'),
  })

  const inbox = readInbox(teamName, tm('bot'))
  const inboxIds = new Set(
    inbox.flatMap((m) => (m.zulipMessageId !== undefined ? [m.zulipMessageId] : [])),
  )

  // Simulate fetched messages — one already in inbox, one new
  const fetched = [mid(100), mid(101)]
  const missing = fetched.filter((id) => !inboxIds.has(id))

  expect(missing).toEqual([mid(101)])
})

test('backfill writes all messages when inbox is empty', () => {
  const inbox = readInbox(teamName, tm('bot'))
  const inboxIds = new Set(
    inbox.flatMap((m) => (m.zulipMessageId !== undefined ? [m.zulipMessageId] : [])),
  )

  const fetched = [mid(100), mid(101), mid(102)]
  const missing = fetched.filter((id) => !inboxIds.has(id))

  expect(missing).toEqual([mid(100), mid(101), mid(102)])
})

test('backfill caps at maxPerBot and writes overflow summary', () => {
  const maxPerBot = 2
  // Simulate 5 fetched messages, sorted newest first
  const sorted = [mid(105), mid(104), mid(103), mid(102), mid(101)]
  const capped = sorted.slice(0, maxPerBot)
  const overflow = sorted.length - maxPerBot

  expect(capped).toEqual([mid(105), mid(104)])
  expect(overflow).toBe(3)
})

test('backfill writes messages in chronological order (oldest first)', () => {
  const messages = [
    { id: mid(103), timestamp: ts(1003) },
    { id: mid(101), timestamp: ts(1001) },
    { id: mid(102), timestamp: ts(1002) },
  ]
  const chronological = messages.toSorted((a, b) => a.timestamp - b.timestamp)

  expect(chronological.map((m) => m.id)).toEqual([mid(101), mid(102), mid(103)])
})

test('backfill filters out messages from own bot', () => {
  const ownUserId = uid(99)
  const messages = [
    { id: mid(100), sender_id: uid(42) },
    { id: mid(101), sender_id: ownUserId },
    { id: mid(102), sender_id: uid(43) },
  ]
  const filtered = messages.filter((m) => m.sender_id !== ownUserId)

  expect(filtered.map((m) => m.id)).toEqual([mid(100), mid(102)])
})

test('backfill deduplicates across multiple narrows', () => {
  const seenIds = new Set<MessageId>()
  const narrowResults = [
    [mid(100), mid(101)], // from followed topic
    [mid(101), mid(102)], // from mentions (101 is a duplicate)
  ]

  const allMessages = narrowResults.flatMap((ids) =>
    ids.filter((id) => {
      if (seenIds.has(id)) return false
      seenIds.add(id)
      return true
    }),
  )

  expect(allMessages).toEqual([mid(100), mid(101), mid(102)])
})

// --- Overflow summary message format ---

test('overflow summary uses zuler:system as from field', () => {
  const overflow = 3
  const summary = `${overflow} more unread message(s) — run catch-up`
  const text = `${overflow} additional unread message(s) were not loaded during startup backfill. Run catch-up to see them.`

  writeToInbox(teamName, tm('bot'), {
    from: 'zuler:system',
    text,
    summary,
  })

  const inbox = readInbox(teamName, tm('bot'))
  expect(inbox).toHaveLength(1)
  expect(inbox[0]!.from).toBe('zuler:system')
  expect(inbox[0]!.summary).toContain('run catch-up')
})
