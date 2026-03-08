import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createClient } from 'zulip-ts'
import { createMcpServer } from './mcp/server.ts'
import { openDatabase } from './state/db.ts'
import { startEventListener } from './zulip/event-listener.ts'

const t0 = performance.now()

const zulipSite = process.env.ZULIP_SITE
const zulipEmail = process.env.ZULIP_EMAIL
const zulipApiKey = process.env.ZULIP_API_KEY
const teamName = process.env.ZULER_TEAM ?? 'default'
const repoRoot = process.env.ZULER_REPO_ROOT ?? process.cwd()

if (!zulipSite || !zulipEmail || !zulipApiKey) {
  console.error('Missing ZULIP_SITE, ZULIP_EMAIL, or ZULIP_API_KEY')
  process.exit(1)
}

const t1 = performance.now()
const db = openDatabase(repoRoot)
const tDb = performance.now()
console.error(`[zuler] db opened in ${(tDb - t1).toFixed(0)}ms`)

const adminClient = createClient({ site: zulipSite, email: zulipEmail, apiKey: zulipApiKey })

const server = createMcpServer({ db, zulipSite, zulipEmail, zulipApiKey, teamName })
const tServer = performance.now()
console.error(`[zuler] server created in ${(tServer - tDb).toFixed(0)}ms`)

// Start event listener in background
startEventListener({
  client: adminClient,
  db,
  teamName,
  signal: new AbortController().signal,
  onRoute: (info) => {
    const location = info.stream ? `${info.stream}/${info.topic}` : 'DM'
    console.error(`[zuler] ${location} from ${info.sender} → ${info.deliveredTo.join(', ')}`)
  },
  onError: (err) => {
    console.error('[zuler] event listener error:', err)
  },
})

const transport = new StdioServerTransport()
await server.connect(transport)
const tReady = performance.now()
console.error(`[zuler] ready in ${(tReady - t0).toFixed(0)}ms`)
