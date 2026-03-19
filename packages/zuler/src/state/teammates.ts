import type { Kysely } from 'kysely'
import type { ResultAsync } from 'neverthrow'
import type { UserId } from 'zulip-ts'
import type { ZulerDatabase } from './db.ts'
import { AlreadyExistsError, dbOp, NotFoundError, type StateError } from './db-utils.ts'

export type { StateError } from './db-utils.ts'

export type Teammate = {
  readonly name: string
  readonly botEmail: string
  readonly apiKey: string
  readonly botUserId: UserId | null
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
): ResultAsync<Teammate, StateError> {
  return dbOp(async () => {
    const row = await db
      .selectFrom('teammates')
      .where('name', '=', name)
      .selectAll()
      .executeTakeFirst()

    if (!row) {
      throw new NotFoundError(`teammate '${name}' not found`)
    }

    return {
      name: row.name,
      botEmail: row.bot_email,
      apiKey: row.api_key,
      botUserId: row.bot_user_id as UserId | null,
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
      botUserId: r.bot_user_id as UserId | null,
    }))
  })
}

export function updateTeammateCredentials(
  db: Kysely<ZulerDatabase>,
  name: string,
  updates: {
    readonly apiKey: string
    readonly botUserId: UserId | null
    readonly botEmail: string
  },
): ResultAsync<void, StateError> {
  return dbOp(async () => {
    const result = await db
      .updateTable('teammates')
      .set({
        api_key: updates.apiKey,
        bot_user_id: updates.botUserId,
        bot_email: updates.botEmail,
      })
      .where('name', '=', name)
      .executeTakeFirst()

    if (result.numUpdatedRows === 0n) {
      throw new NotFoundError(`teammate '${name}' not found`)
    }
  })
}
