import { getBots } from './bots.ts'
import { createClient } from './client.ts'
import { getStreams } from './streams.ts'
import type { ApiKey, Email } from './tagged-types.ts'
import { getMembers } from './users.ts'

const site = process.env.ZULIP_SITE
const email = process.env.ZULIP_EMAIL
const apiKey = process.env.ZULIP_API_KEY

if (!site || !email || !apiKey) {
  console.error('Missing ZULIP_SITE, ZULIP_EMAIL, or ZULIP_API_KEY in environment')
  process.exit(1)
}

const client = createClient({ site, email: email as Email, apiKey: apiKey as ApiKey })

console.log('Fetching streams, members, and bots...\n')

const [streamsResult, membersResult, botsResult] = await Promise.all([
  getStreams(client),
  getMembers(client),
  getBots(client),
])

streamsResult.match(
  (res) => {
    console.log(`Streams (${res.streams.length}):`)
    for (const s of res.streams) {
      console.log(`  ${s.name}`)
    }
  },
  (err) => console.error('Streams error:', err),
)

console.log()

membersResult.match(
  (res) => {
    console.log(`Members (${res.members.length}):`)
    for (const m of res.members) {
      console.log(`  ${m.full_name} <${m.email}>${m.is_bot ? ' [bot]' : ''}`)
    }
  },
  (err) => console.error('Members error:', err),
)

console.log()

botsResult.match(
  (res) => {
    console.log(`Bots (${res.bots.length}):`)
    for (const b of res.bots) {
      console.log(`  ${b.full_name} (${b.username})`)
    }
  },
  (err) => console.error('Bots error:', err),
)
