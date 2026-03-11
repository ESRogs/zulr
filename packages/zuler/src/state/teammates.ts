import type { Kysely } from 'kysely'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import type { ZulerDatabase } from './db.ts'

export type Teammate = {
  readonly name: string
  readonly botEmail: string
  readonly apiKey: string
  readonly botUserId: number | null
}

export type TeammateWithSubs = Teammate & {
  readonly streamSubs: readonly string[]
  readonly topicSubs: readonly { readonly stream: string; readonly topic: string }[]
}

export type StateError =
  | { readonly type: 'not_found'; readonly message: string }
  | { readonly type: 'already_exists'; readonly message: string }
  | { readonly type: 'db_error'; readonly message: string }

export const wrapDbError = (e: unknown): StateError => ({
  type: 'db_error',
  message: e instanceof Error ? e.message : String(e),
})

/** Wrap a DB operation that returns a ResultAsync, catching unexpected promise rejections. */
function dbOp<T>(fn: () => Promise<T>): ResultAsync<T, StateError> {
  return okAsync(undefined).andThen(() => ResultAsync.fromPromise(fn(), wrapDbError))
}

export function registerTeammate(
  db: Kysely<ZulerDatabase>,
  teammate: Teammate,
): ResultAsync<Teammate, StateError> {
  return dbOp(async () => {
    const existing = await db
      .selectFrom('teammates')
      .where('name', '=', teammate.name)
      .selectAll()
      .executeTakeFirst()

    return existing
  }).andThen((existing) => {
    if (existing) {
      return errAsync<Teammate, StateError>({
        type: 'already_exists',
        message: `teammate '${teammate.name}' is already registered`,
      })
    }

    return dbOp(async () => {
      await db
        .insertInto('teammates')
        .values({
          name: teammate.name,
          bot_email: teammate.botEmail,
          api_key: teammate.apiKey,
          bot_user_id: teammate.botUserId,
        })
        .execute()
      return teammate
    })
  })
}

export function getTeammate(
  db: Kysely<ZulerDatabase>,
  name: string,
): ResultAsync<TeammateWithSubs, StateError> {
  return dbOp(async () => {
    const row = await db
      .selectFrom('teammates')
      .where('name', '=', name)
      .selectAll()
      .executeTakeFirst()

    if (!row) return undefined

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

    return {
      name: row.name,
      botEmail: row.bot_email,
      apiKey: row.api_key,
      botUserId: row.bot_user_id,
      streamSubs: streamSubs.map((r) => r.stream),
      topicSubs: topicSubs.map((r) => ({ stream: r.stream, topic: r.topic })),
    }
  }).andThen((result) =>
    result
      ? okAsync(result)
      : errAsync<TeammateWithSubs, StateError>({
          type: 'not_found',
          message: `teammate '${name}' not found`,
        }),
  )
}

export function listTeammates(
  db: Kysely<ZulerDatabase>,
): ResultAsync<readonly Teammate[], StateError> {
  return dbOp(async () => {
    const rows = await db.selectFrom('teammates').selectAll().execute()
    return rows.map((r) => ({
      name: r.name,
      botEmail: r.bot_email,
      apiKey: r.api_key,
      botUserId: r.bot_user_id,
    }))
  })
}

export function updateTeammateCredentials(
  db: Kysely<ZulerDatabase>,
  name: string,
  updates: { readonly apiKey: string; readonly botUserId: number | null },
): ResultAsync<void, StateError> {
  return dbOp(async () => {
    const result = await db
      .updateTable('teammates')
      .set({ api_key: updates.apiKey, bot_user_id: updates.botUserId })
      .where('name', '=', name)
      .executeTakeFirst()
    return result.numUpdatedRows
  }).andThen((numUpdated) =>
    numUpdated === 0n
      ? errAsync<void, StateError>({ type: 'not_found', message: `teammate '${name}' not found` })
      : okAsync(undefined),
  )
}
