import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Kysely } from 'kysely'
import { createDatabase, type ZulerDatabase } from './db.ts'
import { getTeammate, listTeammates, registerTeammate } from './teammates.ts'

let db: Kysely<ZulerDatabase>

beforeEach(() => {
  db = createDatabase(':memory:')
})

afterEach(async () => {
  await db.destroy()
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

test('registerTeammate and getTeammate', async () => {
  const result = await registerTeammate(db, alice)
  expect(result.isOk()).toBe(true)

  const fetched = await getTeammate(db, 'alice')
  expect(fetched.isOk()).toBe(true)
  expect(fetched._unsafeUnwrap()).toEqual(alice)
})

test('registerTeammate rejects duplicate', async () => {
  await registerTeammate(db, alice)
  const result = await registerTeammate(db, alice)
  expect(result.isErr()).toBe(true)
  expect(result._unsafeUnwrapErr().type).toBe('already_exists')
})

test('getTeammate returns not_found', async () => {
  const result = await getTeammate(db, 'nobody')
  expect(result.isErr()).toBe(true)
  expect(result._unsafeUnwrapErr().type).toBe('not_found')
})

test('listTeammates', async () => {
  await registerTeammate(db, alice)
  await registerTeammate(db, bob)
  const result = await listTeammates(db)
  expect(result.isOk()).toBe(true)
  expect(result._unsafeUnwrap()).toHaveLength(2)
})
