import { openDatabase } from './db.ts'
import { startServer } from './mcp-server.ts'

const zulipSite = process.env.ZULIP_SITE
const zulipEmail = process.env.ZULIP_EMAIL
const zulipApiKey = process.env.ZULIP_API_KEY
const teamName = process.env.ZULER_TEAM ?? 'default'
const repoRoot = process.env.ZULER_REPO_ROOT ?? process.cwd()

if (!zulipSite || !zulipEmail || !zulipApiKey) {
  console.error('Missing ZULIP_SITE, ZULIP_EMAIL, or ZULIP_API_KEY')
  process.exit(1)
}

const db = openDatabase(repoRoot)

await startServer({
  db,
  zulipSite,
  zulipEmail,
  zulipApiKey,
  teamName,
})
