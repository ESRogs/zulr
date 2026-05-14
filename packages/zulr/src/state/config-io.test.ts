import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Kysely } from 'kysely'
import type { ApiKey, Email } from 'zulip-ts'
import type { TeammateName } from '../tagged-types.ts'
import { exportConfig, parseConfig } from './config-io.ts'
import { createDatabase, type ZulrDatabase } from './db.ts'
import { registerTeammate } from './teammates.ts'

let db: Kysely<ZulrDatabase>

beforeEach(() => {
  db = createDatabase(':memory:')
})

afterEach(async () => {
  await db.destroy()
})

test('export and parse round-trip', async () => {
  await registerTeammate(db, {
    name: 'alice' as TeammateName,
    botEmail: 'alice-bot@test.zulipchat.com' as Email,
    apiKey: 'secret-key-alice' as ApiKey,
    botUserId: null,
  })

  await registerTeammate(db, {
    name: 'bob' as TeammateName,
    botEmail: 'bob-bot@test.zulipchat.com' as Email,
    apiKey: 'secret-key-bob' as ApiKey,
    botUserId: null,
  })

  const exportResult = await exportConfig(db)
  expect(exportResult.isOk()).toBe(true)

  const jsonl = exportResult._unsafeUnwrap()

  // API keys must not appear in the export
  expect(jsonl).not.toContain('secret-key-alice')
  expect(jsonl).not.toContain('secret-key-bob')

  const parseResult = parseConfig(jsonl)
  expect(parseResult.isOk()).toBe(true)

  const records = parseResult._unsafeUnwrap()
  expect(records).toHaveLength(2)

  const alice = records.find((r) => r.name === 'alice')
  expect(alice).toBeDefined()
  expect(alice!.type).toBe('teammate')

  const bob = records.find((r) => r.name === 'bob')
  expect(bob).toBeDefined()
  expect(bob!.type).toBe('teammate')
})

test('parseConfig rejects invalid JSON', () => {
  const result = parseConfig('not json')
  expect(result.isErr()).toBe(true)
  expect(result._unsafeUnwrapErr().message).toContain('line 1')
})

test('parseConfig handles empty input', () => {
  const result = parseConfig('')
  expect(result.isOk()).toBe(true)
  expect(result._unsafeUnwrap()).toEqual([])
})
