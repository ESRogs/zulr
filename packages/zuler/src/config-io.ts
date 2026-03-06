import type { Kysely } from 'kysely'
import { err, ok, type Result } from 'neverthrow'
import type { ZulerDatabase } from './db.ts'
import type { StateError } from './state.ts'

/**
 * A single line in the exported JSONL config file.
 * Each line is either a teammate (with subscriptions) or could be
 * extended with other record types in the future.
 */
type ExportedTeammate = {
  readonly type: 'teammate'
  readonly name: string
  readonly streamSubs: readonly string[]
  readonly topicSubs: readonly { readonly stream: string; readonly topic: string }[]
}

type ExportedRecord = ExportedTeammate

/** Export all teammates and subscriptions as JSONL (one JSON object per line). No API keys. */
export async function exportConfig(db: Kysely<ZulerDatabase>): Promise<Result<string, StateError>> {
  try {
    const teammates = await db.selectFrom('teammates').select('name').execute()

    const lines: string[] = []

    for (const { name } of teammates) {
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

      const record: ExportedTeammate = {
        type: 'teammate',
        name,
        streamSubs: streamSubs.map((r) => r.stream),
        topicSubs: topicSubs.map((r) => ({ stream: r.stream, topic: r.topic })),
      }

      lines.push(JSON.stringify(record))
    }

    return ok(lines.join('\n'))
  } catch (e) {
    return err({
      type: 'db_error',
      message: e instanceof Error ? e.message : String(e),
    })
  }
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
