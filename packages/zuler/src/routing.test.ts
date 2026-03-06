import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import type { Kysely } from 'kysely'
import type { Message } from 'zulip-ts'
import { createDatabase, type ZulerDatabase } from './db.ts'
import { registerTeammate, addStreamSubscription, addTopicSubscription } from './state.ts'
import { routeMessage } from './routing.ts'
import { readInbox } from './inbox.ts'

let db: Kysely<ZulerDatabase>

// Use a unique team name per test to avoid inbox file collisions
let teamName: string
let inboxDirPath: string

beforeEach(() => {
  db = createDatabase(':memory:')
  teamName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  inboxDirPath = join(homedir(), '.claude', 'teams', teamName, 'inboxes')
})

afterEach(async () => {
  await db.destroy()
  rmSync(inboxDirPath, { recursive: true, force: true })
  // Clean up the team dir too
  rmSync(join(homedir(), '.claude', 'teams', teamName), { recursive: true, force: true })
})

const makeStreamMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 1,
  sender_id: 100,
  sender_email: 'human@example.com',
  sender_full_name: 'Human User',
  type: 'stream',
  display_recipient: 'general',
  subject: 'greetings',
  content: 'hello everyone',
  timestamp: Date.now() / 1000,
  ...overrides,
})

const makeDmMessage = (overrides: Partial<Message> = {}): Message => ({
  id: 2,
  sender_id: 100,
  sender_email: 'human@example.com',
  sender_full_name: 'Human User',
  type: 'private',
  display_recipient: [
    { id: 100, email: 'human@example.com', full_name: 'Human User' },
    { id: 200, email: 'alice-bot@test.zulipchat.com', full_name: 'alice' },
  ],
  content: 'hey alice',
  timestamp: Date.now() / 1000,
  ...overrides,
})

const alice = {
  name: 'alice',
  botEmail: 'alice-bot@test.zulipchat.com',
  apiKey: 'key-alice',
}

const bob = {
  name: 'bob',
  botEmail: 'bob-bot@test.zulipchat.com',
  apiKey: 'key-bob',
}

test('stream message delivered to subscribed teammate', async () => {
  await registerTeammate(db, alice)
  await addStreamSubscription(db, 'alice', 'general')

  const result = await routeMessage(db, teamName, makeStreamMessage())

  expect(result.delivered).toHaveLength(1)
  expect(result.delivered[0]!.teammate).toBe('alice')

  const inbox = readInbox(teamName, 'alice')
  expect(inbox).toHaveLength(1)
  expect(inbox[0]!.from).toBe('zulip:Human User in general/greetings')
  expect(inbox[0]!.text).toBe('hello everyone')
  expect(inbox[0]!.read).toBe(false)
})

test('stream message not delivered to unsubscribed teammate', async () => {
  await registerTeammate(db, alice)
  // No subscription

  const result = await routeMessage(db, teamName, makeStreamMessage())

  expect(result.delivered).toHaveLength(0)
  expect(readInbox(teamName, 'alice')).toHaveLength(0)
})

test('topic subscription matches specific topic', async () => {
  await registerTeammate(db, alice)
  await addTopicSubscription(db, 'alice', 'general', 'greetings')

  const result = await routeMessage(db, teamName, makeStreamMessage())
  expect(result.delivered).toHaveLength(1)

  // Different topic should not match
  const result2 = await routeMessage(db, teamName, makeStreamMessage({
    subject: 'other-topic',
  }))
  expect(result2.delivered).toHaveLength(0)
})

test('sender bot does not receive its own message', async () => {
  await registerTeammate(db, alice)
  await addStreamSubscription(db, 'alice', 'general')

  const result = await routeMessage(db, teamName, makeStreamMessage({
    sender_email: 'alice-bot@test.zulipchat.com',
    sender_full_name: 'alice',
  }))

  expect(result.delivered).toHaveLength(0)
})

test('other bots do receive stream messages', async () => {
  await registerTeammate(db, alice)
  await registerTeammate(db, bob)
  await addStreamSubscription(db, 'bob', 'general')

  // alice sends a stream message — bob should receive it
  const result = await routeMessage(db, teamName, makeStreamMessage({
    sender_email: 'alice-bot@test.zulipchat.com',
    sender_full_name: 'alice',
  }))

  expect(result.delivered).toHaveLength(1)
  expect(result.delivered[0]!.teammate).toBe('bob')
})

test('@-mention auto-subscribes and delivers', async () => {
  await registerTeammate(db, alice)

  const result = await routeMessage(db, teamName, makeStreamMessage({
    content: 'hey @**alice** check this out',
  }))

  expect(result.delivered).toHaveLength(1)
  expect(result.delivered[0]!.teammate).toBe('alice')
  expect(result.autoSubscribed).toHaveLength(1)
  expect(result.autoSubscribed[0]).toEqual({
    teammate: 'alice',
    stream: 'general',
    topic: 'greetings',
  })

  const inbox = readInbox(teamName, 'alice')
  expect(inbox).toHaveLength(1)
})

test('@-mention does not duplicate delivery if already subscribed', async () => {
  await registerTeammate(db, alice)
  await addStreamSubscription(db, 'alice', 'general')

  const result = await routeMessage(db, teamName, makeStreamMessage({
    content: 'hey @**alice** check this out',
  }))

  expect(result.delivered).toHaveLength(1)
  expect(result.autoSubscribed).toHaveLength(0) // already subscribed, no auto-sub
  expect(readInbox(teamName, 'alice')).toHaveLength(1) // delivered once
})

test('DM routed to recipient teammate', async () => {
  await registerTeammate(db, alice)

  const result = await routeMessage(db, teamName, makeDmMessage())

  expect(result.delivered).toHaveLength(1)
  expect(result.delivered[0]!.teammate).toBe('alice')

  const inbox = readInbox(teamName, 'alice')
  expect(inbox).toHaveLength(1)
  expect(inbox[0]!.from).toBe('zulip:Human User')
  expect(inbox[0]!.text).toBe('hey alice')
})

test('DM not delivered back to sender bot', async () => {
  await registerTeammate(db, alice)
  await registerTeammate(db, bob)

  // alice sends a DM to bob
  const result = await routeMessage(db, teamName, makeDmMessage({
    sender_email: 'alice-bot@test.zulipchat.com',
    sender_full_name: 'alice',
    display_recipient: [
      { id: 200, email: 'alice-bot@test.zulipchat.com', full_name: 'alice' },
      { id: 300, email: 'bob-bot@test.zulipchat.com', full_name: 'bob' },
    ],
    content: 'hey bob',
  }))

  expect(result.delivered).toHaveLength(1)
  expect(result.delivered[0]!.teammate).toBe('bob')
  expect(readInbox(teamName, 'alice')).toHaveLength(0)
})

test('multiple teammates receive same stream message', async () => {
  await registerTeammate(db, alice)
  await registerTeammate(db, bob)
  await addStreamSubscription(db, 'alice', 'general')
  await addStreamSubscription(db, 'bob', 'general')

  const result = await routeMessage(db, teamName, makeStreamMessage())

  expect(result.delivered).toHaveLength(2)
  expect(readInbox(teamName, 'alice')).toHaveLength(1)
  expect(readInbox(teamName, 'bob')).toHaveLength(1)
})
