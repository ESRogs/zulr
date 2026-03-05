import { type Result, ok, err } from 'neverthrow'
import type { Kysely } from 'kysely'
import type { ZulerDatabase } from './db.ts'

export type Teammate = {
  readonly name: string
  readonly botEmail: string
  readonly apiKey: string
}

export type TeammateWithSubs = Teammate & {
  readonly streamSubs: readonly string[]
  readonly topicSubs: readonly { readonly stream: string; readonly topic: string }[]
}

export type StateError =
  | { readonly type: 'not_found'; readonly message: string }
  | { readonly type: 'already_exists'; readonly message: string }
  | { readonly type: 'db_error'; readonly message: string }

const wrapDbError = (e: unknown): StateError => ({
  type: 'db_error',
  message: e instanceof Error ? e.message : String(e),
})

export const registerTeammate = async (
  db: Kysely<ZulerDatabase>,
  teammate: Teammate,
): Promise<Result<Teammate, StateError>> => {
  try {
    const existing = await db
      .selectFrom('teammates')
      .where('name', '=', teammate.name)
      .selectAll()
      .executeTakeFirst()

    if (existing) {
      return err({
        type: 'already_exists',
        message: `teammate '${teammate.name}' is already registered`,
      })
    }

    await db
      .insertInto('teammates')
      .values({
        name: teammate.name,
        bot_email: teammate.botEmail,
        api_key: teammate.apiKey,
      })
      .execute()

    return ok(teammate)
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export const getTeammate = async (
  db: Kysely<ZulerDatabase>,
  name: string,
): Promise<Result<TeammateWithSubs, StateError>> => {
  try {
    const row = await db
      .selectFrom('teammates')
      .where('name', '=', name)
      .selectAll()
      .executeTakeFirst()

    if (!row) {
      return err({ type: 'not_found', message: `teammate '${name}' not found` })
    }

    const streamSubs = await db
      .selectFrom('stream_subscriptions')
      .where('teammate_name', '=', name)
      .select('stream')
      .execute()

    const topicSubs = await db
      .selectFrom('topic_subscriptions')
      .where('teammate_name', '=', name)
      .select(['stream', 'topic'])
      .execute()

    return ok({
      name: row.name,
      botEmail: row.bot_email,
      apiKey: row.api_key,
      streamSubs: streamSubs.map((r) => r.stream),
      topicSubs: topicSubs.map((r) => ({ stream: r.stream, topic: r.topic })),
    })
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export const listTeammates = async (
  db: Kysely<ZulerDatabase>,
): Promise<Result<readonly Teammate[], StateError>> => {
  try {
    const rows = await db
      .selectFrom('teammates')
      .selectAll()
      .execute()

    return ok(
      rows.map((r) => ({
        name: r.name,
        botEmail: r.bot_email,
        apiKey: r.api_key,
      })),
    )
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export const addStreamSubscription = async (
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): Promise<Result<void, StateError>> => {
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

export const removeStreamSubscription = async (
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): Promise<Result<void, StateError>> => {
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

export const addTopicSubscription = async (
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): Promise<Result<void, StateError>> => {
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

export const removeTopicSubscription = async (
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): Promise<Result<void, StateError>> => {
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

export const removeAllStreamSubscriptions = async (
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
): Promise<Result<void, StateError>> => {
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

export const shouldReceive = async (
  db: Kysely<ZulerDatabase>,
  teammateName: string,
  stream: string,
  topic: string,
): Promise<Result<boolean, StateError>> => {
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
