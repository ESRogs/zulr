import { appendFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createClient } from 'zulip-ts'
import { createMcpServer } from './mcp/server.ts'
import { openDatabase, stateDir } from './state/db.ts'
import { startEventListener } from './zulip/event-listener.ts'

const t0 = performance.now()

const teamName = process.env.ZULER_TEAM ?? 'default'
const repoRoot = process.env.ZULER_REPO_ROOT ?? process.cwd()

const logFile = `${stateDir(repoRoot)}/zuler.log`
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.error(line.trimEnd())
  appendFileSync(logFile, line)
}

const t1 = performance.now()
const db = openDatabase(repoRoot)
const tDb = performance.now()
log(`db opened in ${(tDb - t1).toFixed(0)}ms`)

const server = createMcpServer({ db, teamName, repoRoot })
const tServer = performance.now()
log(`server created in ${(tServer - tDb).toFixed(0)}ms`)

// Start event listener if credentials are available
const zulipSite = process.env.ZULIP_SITE
const zulipEmail = process.env.ZULIP_EMAIL
const zulipApiKey = process.env.ZULIP_API_KEY

if (zulipSite && zulipEmail && zulipApiKey) {
  const adminClient = createClient({ site: zulipSite, email: zulipEmail, apiKey: zulipApiKey })
  startEventListener({
    client: adminClient,
    db,
    teamName,
    signal: new AbortController().signal,
    onRoute: (info) => {
      const location = info.stream ? `${info.stream}/${info.topic}` : 'DM'
      log(`${location} from ${info.sender} → ${info.deliveredTo.join(', ')}`)
    },
    onError: (err) => {
      log(`event listener error: ${err}`)
    },
  })
} else {
  log('Zulip credentials not configured — call the init tool for setup instructions.')
}

const transport = new StdioServerTransport()
await server.connect(transport)
const tReady = performance.now()
log(`ready in ${(tReady - t0).toFixed(0)}ms`)
