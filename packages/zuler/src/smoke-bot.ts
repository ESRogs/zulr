import { createClient } from 'zulip-ts'
import { clientForTeammate, registerBot } from './bot-manager.ts'
import { createDatabase } from './db.ts'
import { listTeammates } from './state.ts'

const site = process.env.ZULIP_SITE
const email = process.env.ZULIP_EMAIL
const apiKey = process.env.ZULIP_API_KEY

if (!site || !email || !apiKey) {
  console.error('Missing ZULIP_SITE, ZULIP_EMAIL, or ZULIP_API_KEY in environment')
  process.exit(1)
}

const botName = process.argv[2] ?? 'test-bot'

const adminClient = createClient({ site, email, apiKey })
const db = createDatabase(':memory:')

console.log(`Registering bot '${botName}'...\n`)

const result = await registerBot(adminClient, db, botName)

result.match(
  (info) => {
    console.log(`Registered:`)
    console.log(`  email: ${info.botEmail}`)
    console.log(`  api_key: ${info.apiKey.slice(0, 8)}...`)
  },
  (err) => {
    console.error('Registration failed:', err)
    process.exit(1)
  },
)

console.log()

const teammates = await listTeammates(db)
teammates.match(
  (list) => {
    console.log(`Teammates in DB (${list.length}):`)
    for (const t of list) {
      console.log(`  ${t.name} <${t.botEmail}>`)
    }
  },
  (err) => console.error('List error:', err),
)

console.log()

const botClient = await clientForTeammate(db, site, botName)
botClient.match(
  (client) => {
    console.log(`Client for '${botName}': ${client.config.email}`)
  },
  (err) => console.error('Client error:', err),
)

await db.destroy()
