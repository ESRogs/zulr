import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import type {
  ApiKey,
  DisplayName,
  DmMessage,
  Email,
  MessageId,
  UnixEpochSeconds,
  UserId,
} from 'zulip-ts'
import { createDatabase, type ZulrDatabase } from '../state/db.ts'
import { registerTeammate } from '../state/teammates.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { readInbox } from './inbox.ts'
import { routeDm } from './routing.ts'

let db: Kysely<ZulrDatabase>

// Use a unique team name per test to avoid inbox file collisions
let teamName: TeamName
let inboxDirPath: string

beforeEach(() => {
  db = createDatabase(':memory:')
  teamName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}` as TeamName
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
  sender_email: 'human@example.com' as Email,
  sender_full_name: 'Human User' as DisplayName,
  type: 'private',
  display_recipient: [
    {
      id: 100 as UserId,
      email: 'human@example.com' as Email,
      full_name: 'Human User' as DisplayName,
    },
    {
      id: 200 as UserId,
      email: 'alice-bot@test.zulipchat.com' as Email,
      full_name: 'alice' as DisplayName,
    },
  ],
  content: 'hey alice',
  timestamp: (Date.now() / 1000) as UnixEpochSeconds,
  reactions: [],
  ...overrides,
})

const alice = {
  name: 'alice' as TeammateName,
  botEmail: 'alice-bot@test.zulipchat.com' as Email,
  apiKey: 'key-alice' as ApiKey,
  botUserId: null,
}

const bob = {
  name: 'bob' as TeammateName,
  botEmail: 'bob-bot@test.zulipchat.com' as Email,
  apiKey: 'key-bob' as ApiKey,
  botUserId: null,
}

test('DM routed to recipient teammate', async () => {
  await registerTeammate(db, alice)

  const result = await routeDm(db, teamName, makeDmMessage())

  expect(result.isOk()).toBe(true)
  const value = result._unsafeUnwrap()
  expect(value.delivered).toHaveLength(1)
  expect(value.delivered[0]!.teammate).toBe('alice' as TeammateName)

  const inbox = readInbox(teamName, 'alice' as TeammateName)._unsafeUnwrap()
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
      sender_email: 'alice-bot@test.zulipchat.com' as Email,
      sender_full_name: 'alice' as DisplayName,
      display_recipient: [
        {
          id: 200 as UserId,
          email: 'alice-bot@test.zulipchat.com' as Email,
          full_name: 'alice' as DisplayName,
        },
        {
          id: 300 as UserId,
          email: 'bob-bot@test.zulipchat.com' as Email,
          full_name: 'bob' as DisplayName,
        },
      ],
      content: 'hey bob',
    }),
  )

  expect(result.isOk()).toBe(true)
  const value = result._unsafeUnwrap()
  expect(value.delivered).toHaveLength(1)
  expect(value.delivered[0]!.teammate).toBe('bob' as TeammateName)
  expect(readInbox(teamName, 'alice' as TeammateName)._unsafeUnwrap()).toHaveLength(0)
})

test('DM with targetBot only delivers to that bot', async () => {
  await registerTeammate(db, alice)
  await registerTeammate(db, bob)

  const msg = makeDmMessage({
    display_recipient: [
      {
        id: 100 as UserId,
        email: 'human@example.com' as Email,
        full_name: 'Human User' as DisplayName,
      },
      {
        id: 200 as UserId,
        email: 'alice-bot@test.zulipchat.com' as Email,
        full_name: 'alice' as DisplayName,
      },
      {
        id: 300 as UserId,
        email: 'bob-bot@test.zulipchat.com' as Email,
        full_name: 'bob' as DisplayName,
      },
    ],
    content: 'hey everyone',
  })

  const result = await routeDm(db, teamName, msg, 'alice' as TeammateName)

  expect(result.isOk()).toBe(true)
  const value = result._unsafeUnwrap()
  expect(value.delivered).toHaveLength(1)
  expect(value.delivered[0]!.teammate).toBe('alice' as TeammateName)
  expect(readInbox(teamName, 'bob' as TeammateName)._unsafeUnwrap()).toHaveLength(0)
})
