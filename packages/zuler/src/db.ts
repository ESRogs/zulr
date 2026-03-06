import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Kysely } from 'kysely'
import { BunSqliteDialect } from 'kysely-bun-sqlite'

type TeammatesTable = {
  name: string
  bot_email: string
  api_key: string
}

type StreamSubscriptionsTable = {
  teammate_name: string
  stream: string
}

type TopicSubscriptionsTable = {
  teammate_name: string
  stream: string
  topic: string
}

type ZulerDatabase = {
  teammates: TeammatesTable
  stream_subscriptions: StreamSubscriptionsTable
  topic_subscriptions: TopicSubscriptionsTable
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS teammates (
    name TEXT PRIMARY KEY,
    bot_email TEXT NOT NULL,
    api_key TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stream_subscriptions (
    teammate_name TEXT NOT NULL REFERENCES teammates(name),
    stream TEXT NOT NULL,
    PRIMARY KEY (teammate_name, stream)
  );

  CREATE TABLE IF NOT EXISTS topic_subscriptions (
    teammate_name TEXT NOT NULL REFERENCES teammates(name),
    stream TEXT NOT NULL,
    topic TEXT NOT NULL,
    PRIMARY KEY (teammate_name, stream, topic)
  );
`

/** Derive the zuler state directory for a given repo root, matching Claude Code's path convention. */
export function stateDir(repoRoot: string): string {
  const absolute = resolve(repoRoot)
  const slug = absolute.replace(/\//g, '-')
  return join(homedir(), '.zuler', slug)
}

/** Resolve the DB path for a repo root. */
export function statePath(repoRoot: string): string {
  return join(stateDir(repoRoot), 'state.db')
}

/** Open (or create) the zuler database for a given repo root. */
export function openDatabase(repoRoot: string): Kysely<ZulerDatabase> {
  const dir = stateDir(repoRoot)
  mkdirSync(dir, { recursive: true })
  return createDatabase(join(dir, 'state.db'))
}

/** Open a database at an explicit path (for tests or custom locations). */
export function createDatabase(path: string): Kysely<ZulerDatabase> {
  const sqliteDb = new Database(path)
  sqliteDb.exec('PRAGMA journal_mode = WAL;')
  sqliteDb.exec('PRAGMA foreign_keys = ON;')
  sqliteDb.exec(SCHEMA_SQL)

  return new Kysely<ZulerDatabase>({
    dialect: new BunSqliteDialect({ database: sqliteDb }),
  })
}

export type { ZulerDatabase }
