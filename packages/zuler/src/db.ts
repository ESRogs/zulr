import { Database } from 'bun:sqlite'
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

export const createDatabase = (path: string): Kysely<ZulerDatabase> => {
  const sqliteDb = new Database(path)
  sqliteDb.exec('PRAGMA journal_mode = WAL;')
  sqliteDb.exec('PRAGMA foreign_keys = ON;')
  sqliteDb.exec(SCHEMA_SQL)

  return new Kysely<ZulerDatabase>({
    dialect: new BunSqliteDialect({ database: sqliteDb }),
  })
}

export type { ZulerDatabase }
