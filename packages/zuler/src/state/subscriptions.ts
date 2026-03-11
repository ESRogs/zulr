import type { Kysely } from 'kysely'
import type { ResultAsync } from 'neverthrow'
import type { ZulerDatabase } from './db.ts'
import { dbOp, type StateError } from './db-utils.ts'

export function addStreamSubscription(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): ResultAsync<void, StateError> {
  return dbOp(async () => {
    await db
      .insertInto('stream_subscriptions')
      .values({ teammate_name: teammateName, stream })
      .onConflict((oc) => oc.doNothing())
      .execute()
  })
}

export function removeStreamSubscription(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): ResultAsync<void, StateError> {
  return dbOp(async () => {
    await db
      .deleteFrom('stream_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .execute()
  })
}

export function addTopicSubscription(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): ResultAsync<void, StateError> {
  return dbOp(async () => {
    await db
      .insertInto('topic_subscriptions')
      .values({ teammate_name: teammateName, stream, topic })
      .onConflict((oc) => oc.doNothing())
      .execute()
  })
}

export function removeTopicSubscription(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): ResultAsync<void, StateError> {
  return dbOp(async () => {
    await db
      .deleteFrom('topic_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .where('topic', '=', topic)
      .execute()
  })
}

export function removeAllStreamSubscriptions(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): ResultAsync<void, StateError> {
  return dbOp(async () => {
    await db
      .deleteFrom('stream_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .execute()

    await db
      .deleteFrom('topic_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .execute()
  })
}

export function shouldReceive(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): ResultAsync<boolean, StateError> {
  return dbOp(async () => {
    const streamSub = await db
      .selectFrom('stream_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .selectAll()
      .executeTakeFirst()

    if (streamSub) return true

    const topicSub = await db
      .selectFrom('topic_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .where('topic', '=', topic)
      .selectAll()
      .executeTakeFirst()

    return !!topicSub
  })
}
