import type { Kysely } from 'kysely'
import type { ResultAsync } from 'neverthrow'
import type { ZulerDatabase } from './db.ts'
import { AlreadyExistsError, dbOp, NotFoundError, type StateError } from './db-utils.ts'

export type { StateError } from './db-utils.ts'

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

    if (existing) {
      throw new AlreadyExistsError(`teammate '${teammate.name}' is already registered`)
    }

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

    if (!row) {
      throw new NotFoundError(`teammate '${name}' not found`)
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

    return {
      name: row.name,
      botEmail: row.bot_email,
      apiKey: row.api_key,
      botUserId: row.bot_user_id,
      streamSubs: streamSubs.map((r) => r.stream),
      topicSubs: topicSubs.map((r) => ({ stream: r.stream, topic: r.topic })),
    }
  })
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
  updates: {
    readonly apiKey: string
    readonly botUserId: number | null
    readonly botEmail?: string
  },
): ResultAsync<void, StateError> {
  return dbOp(async () => {
    const set: Record<string, unknown> = {
      api_key: updates.apiKey,
      bot_user_id: updates.botUserId,
    }
    if (updates.botEmail) set.bot_email = updates.botEmail

    const result = await db
      .updateTable('teammates')
      .set(set)
      .where('name', '=', name)
      .executeTakeFirst()

    if (result.numUpdatedRows === 0n) {
      throw new NotFoundError(`teammate '${name}' not found`)
    }
  })
}
