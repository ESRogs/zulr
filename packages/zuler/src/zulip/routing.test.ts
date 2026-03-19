import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import type { DmMessage, MessageId, UnixEpochSeconds, UserId } from 'zulip-ts'
import { createDatabase, type ZulerDatabase } from '../state/db.ts'
import { registerTeammate } from '../state/teammates.ts'
import { readInbox } from './inbox.ts'
import { routeDm } from './routing.ts'

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
  rmSync(join(homedir(), '.claude', 'teams', teamName), { recursive: true, force: true })
})

const makeDmMessage = (overrides: Partial<DmMessage> = {}): DmMessage => ({
  id: 2 as MessageId,
  sender_id: 100 as UserId,
  sender_email: 'human@example.com',
  sender_full_name: 'Human User',
  type: 'private',
  display_recipient: [
    { id: 100 as UserId, email: 'human@example.com', full_name: 'Human User' },
    { id: 200 as UserId, email: 'alice-bot@test.zulipchat.com', full_name: 'alice' },
  ],
  content: 'hey alice',
  timestamp: (Date.now() / 1000) as UnixEpochSeconds,
  reactions: [],
  ...overrides,
})

const alice = {
  name: 'alice',
  botEmail: 'alice-bot@test.zulipchat.com',
  apiKey: 'key-alice',
  botUserId: null,
}

const bob = {
  name: 'bob',
  botEmail: 'bob-bot@test.zulipchat.com',
  apiKey: 'key-bob',
  botUserId: null,
}

test('DM routed to recipient teammate', async () => {
  await registerTeammate(db, alice)

  const result = await routeDm(db, teamName, makeDmMessage())

  expect(result.delivered).toHaveLength(1)
  expect(result.delivered[0]!.teammate).toBe('alice')

  const inbox = readInbox(teamName, 'alice')
  expect(inbox).toHaveLength(1)
  expect(inbox[0]!.from).toBe('zulip:Human User')
  expect(inbox[0]!.text).toContain('hey alice')
  expect(inbox[0]!.text).toMatch(/\[msg:\d+ ts:/)
})

test('DM not delivered back to sender bot', async () => {
  await registerTeammate(db, alice)
  await registerTeammate(db, bob)

  // alice sends a DM to bob
  const result = await routeDm(
    db,
    teamName,
    makeDmMessage({
      sender_email: 'alice-bot@test.zulipchat.com',
      sender_full_name: 'alice',
      display_recipient: [
        { id: 200 as UserId, email: 'alice-bot@test.zulipchat.com', full_name: 'alice' },
        { id: 300 as UserId, email: 'bob-bot@test.zulipchat.com', full_name: 'bob' },
      ],
      content: 'hey bob',
    }),
  )

  expect(result.delivered).toHaveLength(1)
  expect(result.delivered[0]!.teammate).toBe('bob')
  expect(readInbox(teamName, 'alice')).toHaveLength(0)
})

test('DM with targetBot only delivers to that bot', async () => {
  await registerTeammate(db, alice)
  await registerTeammate(db, bob)

  const msg = makeDmMessage({
    display_recipient: [
      { id: 100 as UserId, email: 'human@example.com', full_name: 'Human User' },
      { id: 200 as UserId, email: 'alice-bot@test.zulipchat.com', full_name: 'alice' },
      { id: 300 as UserId, email: 'bob-bot@test.zulipchat.com', full_name: 'bob' },
    ],
    content: 'hey everyone',
  })

  const result = await routeDm(db, teamName, msg, 'alice')

  expect(result.delivered).toHaveLength(1)
  expect(result.delivered[0]!.teammate).toBe('alice')
  expect(readInbox(teamName, 'bob')).toHaveLength(0)
})
