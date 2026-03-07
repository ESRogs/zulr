import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Kysely } from 'kysely'
import { createDatabase, type ZulerDatabase } from './db.ts'
import {
  addStreamSubscription,
  addTopicSubscription,
  removeAllStreamSubscriptions,
  removeStreamSubscription,
  removeTopicSubscription,
  shouldReceive,
} from './subscriptions.ts'
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
  expect(fetched._unsafeUnwrap()).toEqual({
    ...alice,
    streamSubs: [],
    topicSubs: [],
  })
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

test('stream subscriptions', async () => {
  await registerTeammate(db, alice)

  await addStreamSubscription(db, 'alice', 'general')
  const fetched = await getTeammate(db, 'alice')
  expect(fetched._unsafeUnwrap().streamSubs).toEqual(['general'])

  // idempotent
  await addStreamSubscription(db, 'alice', 'general')
  const fetched2 = await getTeammate(db, 'alice')
  expect(fetched2._unsafeUnwrap().streamSubs).toEqual(['general'])

  await removeStreamSubscription(db, 'alice', 'general')
  const fetched3 = await getTeammate(db, 'alice')
  expect(fetched3._unsafeUnwrap().streamSubs).toEqual([])
})

test('topic subscriptions', async () => {
  await registerTeammate(db, alice)

  await addTopicSubscription(db, 'alice', 'general', 'greetings')
  const fetched = await getTeammate(db, 'alice')
  expect(fetched._unsafeUnwrap().topicSubs).toEqual([{ stream: 'general', topic: 'greetings' }])

  await removeTopicSubscription(db, 'alice', 'general', 'greetings')
  const fetched2 = await getTeammate(db, 'alice')
  expect(fetched2._unsafeUnwrap().topicSubs).toEqual([])
})

test('removeAllStreamSubscriptions removes stream and topic subs', async () => {
  await registerTeammate(db, alice)
  await addStreamSubscription(db, 'alice', 'general')
  await addTopicSubscription(db, 'alice', 'general', 'greetings')
  await addTopicSubscription(db, 'alice', 'general', 'intros')
  await addTopicSubscription(db, 'alice', 'other-stream', 'topic')

  await removeAllStreamSubscriptions(db, 'alice', 'general')

  const fetched = await getTeammate(db, 'alice')
  const t = fetched._unsafeUnwrap()
  expect(t.streamSubs).toEqual([])
  expect(t.topicSubs).toEqual([{ stream: 'other-stream', topic: 'topic' }])
})

test('shouldReceive matches stream sub', async () => {
  await registerTeammate(db, alice)
  await addStreamSubscription(db, 'alice', 'general')

  const result = await shouldReceive(db, 'alice', 'general', 'any-topic')
  expect(result._unsafeUnwrap()).toBe(true)

  const result2 = await shouldReceive(db, 'alice', 'other', 'any-topic')
  expect(result2._unsafeUnwrap()).toBe(false)
})

test('shouldReceive matches topic sub', async () => {
  await registerTeammate(db, alice)
  await addTopicSubscription(db, 'alice', 'general', 'greetings')

  const result = await shouldReceive(db, 'alice', 'general', 'greetings')
  expect(result._unsafeUnwrap()).toBe(true)

  const result2 = await shouldReceive(db, 'alice', 'general', 'other-topic')
  expect(result2._unsafeUnwrap()).toBe(false)
})
