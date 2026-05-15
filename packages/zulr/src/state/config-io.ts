import type { Kysely } from 'kysely'
import { err, ok, type Result, type ResultAsync } from 'neverthrow'
import type { ZulrDatabase } from './db.ts'
import { dbOp, type StateError } from './db-utils.ts'

/**
 * A single line in the exported JSONL config file.
 * Each line is a teammate record. Subscriptions are managed on Zulip directly.
 */
type ExportedTeammate = {
  readonly type: 'teammate'
  readonly name: string
}

type ExportedRecord = ExportedTeammate

/** Export all teammates as JSONL (one JSON object per line). No API keys. */
export function exportConfig(db: Kysely<ZulrDatabase>): ResultAsync<string, StateError> {
  return dbOp(() => db.selectFrom('teammates').select('name').execute()).map((teammates) =>
    teammates.map(({ name }) => JSON.stringify({ type: 'teammate', name })).join('\n'),
  )
}

/** Parse a JSONL config string into records. */
export function parseConfig(jsonl: string): Result<readonly ExportedRecord[], { message: string }> {
  const lines = jsonl.split('\n').filter((l) => l.trim().length > 0)
  const records: ExportedRecord[] = []

  for (const [i, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as ExportedRecord
      if (parsed.type !== 'teammate') {
        return err({ message: `line ${i + 1}: unknown record type '${parsed.type}'` })
      }
      records.push(parsed)
    } catch {
      return err({ message: `line ${i + 1}: invalid JSON` })
    }
  }

  return ok(records)
}

export type { ExportedRecord, ExportedTeammate }
