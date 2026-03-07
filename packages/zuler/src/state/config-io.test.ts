import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Kysely } from 'kysely'
import { exportConfig, parseConfig } from './config-io.ts'
import { createDatabase, type ZulerDatabase } from './db.ts'
import { addStreamSubscription, addTopicSubscription } from './subscriptions.ts'
import { registerTeammate } from './teammates.ts'

let db: Kysely<ZulerDatabase>

beforeEach(() => {
  db = createDatabase(':memory:')
})

afterEach(async () => {
  await db.destroy()
})

test('export and parse round-trip', async () => {
  await registerTeammate(db, {
    name: 'alice',
    botEmail: 'alice-bot@test.zulipchat.com',
    apiKey: 'secret-key-alice',
    botUserId: null,
  })
  await addStreamSubscription(db, 'alice', 'general')
  await addTopicSubscription(db, 'alice', 'dev', 'frontend')

  await registerTeammate(db, {
    name: 'bob',
    botEmail: 'bob-bot@test.zulipchat.com',
    apiKey: 'secret-key-bob',
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
  expect(alice!.streamSubs).toEqual(['general'])
  expect(alice!.topicSubs).toEqual([{ stream: 'dev', topic: 'frontend' }])

  const bob = records.find((r) => r.name === 'bob')
  expect(bob).toBeDefined()
  expect(bob!.streamSubs).toEqual([])
  expect(bob!.topicSubs).toEqual([])
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
