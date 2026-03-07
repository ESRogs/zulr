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
  bot_user_id: number | null
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
    api_key TEXT NOT NULL,
    bot_user_id INTEGER
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

const CURRENT_SCHEMA_VERSION = 1

const MIGRATIONS: Record<number, string> = {
  1: 'ALTER TABLE teammates ADD COLUMN bot_user_id INTEGER;',
}

function runMigrations(db: Database): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  let version = row.user_version

  while (version < CURRENT_SCHEMA_VERSION) {
    const sql = MIGRATIONS[version + 1]
    if (!sql) break
    db.exec(sql)
    version++
  }

  if (version !== row.user_version) {
    db.exec(`PRAGMA user_version = ${version}`)
  }
}

/** Open a database at an explicit path (for tests or custom locations). */
export function createDatabase(path: string): Kysely<ZulerDatabase> {
  const sqliteDb = new Database(path)
  sqliteDb.exec('PRAGMA journal_mode = WAL;')
  sqliteDb.exec('PRAGMA foreign_keys = ON;')

  // Check if this is a fresh DB (no tables yet)
  const tables = sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  const isFresh = tables.length === 0

  sqliteDb.exec(SCHEMA_SQL)

  if (isFresh) {
    // New DB — schema already includes all columns, skip migrations
    sqliteDb.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`)
  } else {
    runMigrations(sqliteDb)
  }

  return new Kysely<ZulerDatabase>({
    dialect: new BunSqliteDialect({ database: sqliteDb }),
  })
}

export type { ZulerDatabase }
