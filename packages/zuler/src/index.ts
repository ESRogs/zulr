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

function formatError(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err)
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.error(line.trimEnd())
  appendFileSync(logFile, line)
}

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${formatError(err)}`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => log(`UNHANDLED REJECTION: ${formatError(reason)}`))

const t1 = performance.now()
const db = openDatabase(repoRoot)
const tDb = performance.now()
log(`db opened in ${(tDb - t1).toFixed(0)}ms`)

const { server, ctx } = createMcpServer({ db, teamName, repoRoot })
const tServer = performance.now()
log(`server created in ${(tServer - tDb).toFixed(0)}ms`)

function bootEventListener(): void {
  const creds = ctx.getCredentials()
  if (!creds) return

  log(`connecting to ${creds.site} as ${creds.email}`)
  const adminClient = createClient(creds)
  startEventListener({
    client: adminClient,
    db,
    teamName,
    signal: new AbortController().signal,
    onRoute: (info) => {
      const location = info.stream ? `${info.stream}/${info.topic}` : 'DM'
      log(`${location} from ${info.sender} → ${info.deliveredTo.join(', ')}`)
    },
    onReaction: (info) => {
      log(
        `:${info.emoji}: from ${info.reactorName} on msg ${info.messageId} → ${info.deliveredTo.join(', ')}`,
      )
    },
    onError: (err) => log(`event listener error: ${formatError(err)}`),
  })
  log('event listener started')
}

// Start event listener now if credentials are available, or later when they're loaded
if (ctx.isConfigured()) {
  bootEventListener()
} else {
  log('Zulip credentials not configured — waiting for init tool to load them.')
  ctx.onCredentialsLoaded(bootEventListener)
}

server.server.onerror = (err) => log(`MCP server error: ${formatError(err)}`)

const transport = new StdioServerTransport()
transport.onerror = (err) => log(`MCP transport error: ${formatError(err)}`)
transport.onclose = () => log('MCP transport closed')
await server.connect(transport)
const tReady = performance.now()
log(`ready in ${(tReady - t0).toFixed(0)}ms`)
