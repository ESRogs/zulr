import type { Kysely } from 'kysely'
import type { ResultAsync } from 'neverthrow'
import type { ApiKey, Email, UserId } from 'zulip-ts'
import type { TeammateName } from '../tagged-types.ts'
import type { ZulerDatabase } from './db.ts'
import { AlreadyExistsError, dbOp, NotFoundError, type StateError } from './db-utils.ts'

export type { StateError } from './db-utils.ts'

export type Teammate = {
  readonly name: TeammateName
  readonly botEmail: Email
  readonly apiKey: ApiKey
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
  name: TeammateName,
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
      name: row.name as TeammateName,
      botEmail: row.bot_email as Email,
      apiKey: row.api_key as ApiKey,
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
      name: r.name as TeammateName,
      botEmail: r.bot_email as Email,
      apiKey: r.api_key as ApiKey,
      botUserId: r.bot_user_id as UserId | null,
    }))
  })
}

export function updateTeammateCredentials(
  db: Kysely<ZulerDatabase>,
  name: TeammateName,
  updates: {
    readonly apiKey: ApiKey
    readonly botUserId: UserId | null
    readonly botEmail: Email
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
