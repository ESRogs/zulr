import { appendFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './mcp/server.ts'
import { openDatabase, stateDir } from './state/db.ts'
import type { TeamName } from './tagged-types.ts'
import { createEventListenerManager } from './zulip/event-listener.ts'

const t0 = performance.now()

const rawTeamName = process.env.ZULER_TEAM ?? 'default'
if (rawTeamName.length === 0) {
  throw new Error('ZULER_TEAM must not be empty')
}
const teamName = rawTeamName as TeamName
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

function bootEventListeners(): void {
  const creds = ctx.getCredentials()
  if (!creds) return

  log(`connecting to ${creds.site}`)
  const manager = createEventListenerManager({
    db,
    teamName,
    site: creds.site,
    signal: new AbortController().signal,
    onRoute: (info) => {
      const location = info.stream ? `${info.stream}/${info.topic}` : 'DM'
      log(`[${info.botName}] ${location} from ${info.sender}`)
    },
    onReaction: (info) => {
      log(
        `:${info.emoji}: from ${info.reactorName} on msg ${info.messageId} → ${info.deliveredTo.join(', ')}`,
      )
    },
    onError: (err) => log(`event listener error: ${formatError(err)}`),
  })

  // Expose manager on ctx so register tool can start listeners for new bots
  ctx.setEventListenerManager(manager)

  manager.startAll()
  log('per-bot event listeners started')
}

// Start event listeners now if credentials are available, or later when they're loaded
if (ctx.isConfigured()) {
  bootEventListeners()
} else {
  log('Zulip credentials not configured — waiting for init tool to load them.')
  ctx.onCredentialsLoaded(bootEventListeners)
}

server.server.onerror = (err) => log(`MCP server error: ${formatError(err)}`)

const transport = new StdioServerTransport()
transport.onerror = (err) => log(`MCP transport error: ${formatError(err)}`)
transport.onclose = () => log('MCP transport closed')
await server.connect(transport)
server.sendToolListChanged()
const tReady = performance.now()
log(`ready in ${(tReady - t0).toFixed(0)}ms`)
