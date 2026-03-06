import type { Kysely } from 'kysely'
import { err, ok, type Result } from 'neverthrow'
import type { ZulerDatabase } from './db.ts'
import { type StateError, wrapDbError } from './teammates.ts'

export async function addStreamSubscription(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): Promise<Result<void, StateError>> {
  try {
    await db
      .insertInto('stream_subscriptions')
      .values({ teammate_name: teammateName, stream })
      .onConflict((oc) => oc.doNothing())
      .execute()

    return ok(undefined)
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export async function removeStreamSubscription(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): Promise<Result<void, StateError>> {
  try {
    await db
      .deleteFrom('stream_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .execute()

    return ok(undefined)
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export async function addTopicSubscription(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): Promise<Result<void, StateError>> {
  try {
    await db
      .insertInto('topic_subscriptions')
      .values({ teammate_name: teammateName, stream, topic })
      .onConflict((oc) => oc.doNothing())
      .execute()

    return ok(undefined)
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export async function removeTopicSubscription(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): Promise<Result<void, StateError>> {
  try {
    await db
      .deleteFrom('topic_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .where('topic', '=', topic)
      .execute()

    return ok(undefined)
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export async function removeAllStreamSubscriptions(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): Promise<Result<void, StateError>> {
  try {
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

    return ok(undefined)
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export async function shouldReceive(
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): Promise<Result<boolean, StateError>> {
  try {
    const streamSub = await db
      .selectFrom('stream_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .selectAll()
      .executeTakeFirst()

    if (streamSub) return ok(true)

    const topicSub = await db
      .selectFrom('topic_subscriptions')
      .where('teammate_name', '=', teammateName)
      .where('stream', '=', stream)
      .where('topic', '=', topic)
      .selectAll()
      .executeTakeFirst()

    return ok(!!topicSub)
  } catch (e) {
    return err(wrapDbError(e))
  }
}
