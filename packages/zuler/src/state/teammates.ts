import type { Kysely } from 'kysely'
import { err, ok, type Result } from 'neverthrow'
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

export async function registerTeammate(
  db: Kysely<ZulerDatabase>,
  teammate: Teammate,
): Promise<Result<Teammate, StateError>> {
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
        bot_user_id: teammate.botUserId,
      })
      .execute()

    return ok(teammate)
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export async function getTeammate(
  db: Kysely<ZulerDatabase>,
  name: string,
): Promise<Result<TeammateWithSubs, StateError>> {
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
      botUserId: row.bot_user_id,
      streamSubs: streamSubs.map((r) => r.stream),
      topicSubs: topicSubs.map((r) => ({ stream: r.stream, topic: r.topic })),
    })
  } catch (e) {
    return err(wrapDbError(e))
  }
}

export async function listTeammates(
  db: Kysely<ZulerDatabase>,
): Promise<Result<readonly Teammate[], StateError>> {
  try {
    const rows = await db.selectFrom('teammates').selectAll().execute()

    return ok(
      rows.map((r) => ({
        name: r.name,
        botEmail: r.bot_email,
        apiKey: r.api_key,
        botUserId: r.bot_user_id,
      })),
    )
  } catch (e) {
    return err(wrapDbError(e))
  }
}

/** Check if a Zulip user ID belongs to a registered bot. */
export async function isBotUserId(db: Kysely<ZulerDatabase>, userId: number): Promise<boolean> {
  const row = await db
    .selectFrom('teammates')
    .where('bot_user_id', '=', userId)
    .selectAll()
    .executeTakeFirst()
  return !!row
}
