import { appendFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getErrorMessage } from './errors.ts'
import { createMcpServer } from './mcp/server.ts'
import { openDatabase, stateDir } from './state/db.ts'
import type { TeammateName, TeamName } from './tagged-types.ts'
import { backfillAllInboxes } from './zulip/backfill.ts'
import { createEventListenerManager } from './zulip/event-listener.ts'

const t0 = performance.now()

const rawTeamName = process.env.ZULER_TEAM ?? 'default'
if (rawTeamName.length === 0) {
  throw new Error('ZULER_TEAM must not be empty')
}
const teamName = rawTeamName as TeamName
const repoRoot = process.env.ZULER_REPO_ROOT ?? process.cwd()
const agentName = process.env.ZULER_AGENT ? (process.env.ZULER_AGENT as TeammateName) : undefined
/** In standalone mode, route all messages to the "team-lead" inbox since the agent is team-lead of its own per-agent team. */
const STANDALONE_INBOX_NAME = 'team-lead' as TeammateName

const logFile = `${stateDir(repoRoot)}/zuler.log`

/** Pick the most useful params for each tool to keep log lines concise. */
function summarizeToolParams(_tool: string, params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (k === 'content' && typeof v === 'string') {
      const preview = v.length > 60 ? `${v.slice(0, 60)}...` : v
      parts.push(`content="${preview}"`)
    } else if (
      (typeof v === 'string' && v.length <= 80) ||
      typeof v === 'number' ||
      typeof v === 'boolean'
    ) {
      parts.push(`${k}=${v}`)
    }
  }
  return parts.join(' ')
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  console.error(line.trimEnd())
  appendFileSync(logFile, line)
}

process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${getErrorMessage(err)}`)
  process.exit(1)
})
process.on('unhandledRejection', (reason) => log(`UNHANDLED REJECTION: ${getErrorMessage(reason)}`))

const t1 = performance.now()
const db = openDatabase(repoRoot)
const tDb = performance.now()
log(`db opened in ${(tDb - t1).toFixed(0)}ms`)

const { server, ctx } = createMcpServer({
  db,
  teamName,
  repoRoot,
  agentName,
  onToolCall: (name, params) => {
    const keyParams = summarizeToolParams(name, params)
    log(`tool:${name}${keyParams ? ` ${keyParams}` : ''}`)
  },
})
const tServer = performance.now()
log(
  `server created in ${(tServer - tDb).toFixed(0)}ms${agentName ? ` (standalone: ${agentName})` : ''}`,
)

async function bootEventListeners(): Promise<void> {
  const creds = ctx.credentials.getCredentials()
  if (!creds) return

  log(`connecting to ${creds.site}${agentName ? ` as ${agentName} (standalone)` : ''}`)

  // In standalone mode, reuse the pre-built client from StandaloneCredentials
  const standaloneClient = agentName ? ctx.credentials.getAdminClient() : undefined
  const standaloneBot =
    agentName && standaloneClient ? { client: standaloneClient, email: creds.email } : undefined

  const manager = createEventListenerManager({
    db,
    teamName,
    site: creds.site,
    standaloneBot,
    inboxName: agentName ? STANDALONE_INBOX_NAME : undefined,
    signal: new AbortController().signal,
    onRoute: (info) => {
      const location = info.stream ? `${info.stream}/${info.topic}` : 'DM'
      log(`[${info.botName}] ${location} from ${info.sender}: ${info.summary}`)
    },
    onReaction: (info) => {
      log(
        `:${info.emoji}: from ${info.reactorName} on msg ${info.messageId} → ${info.deliveredTo.join(', ')}`,
      )
    },
    onError: (err) => log(`event listener error: ${getErrorMessage(err)}`),
  })

  // Expose manager on ctx so register tool can start listeners for new bots
  ctx.setEventListenerManager(manager)

  if (agentName) {
    await manager.startBot(agentName)
    log(`event listener started for ${agentName}`)
  } else {
    await manager.startAll()
    log('per-bot event listeners started')
  }

  backfillAllInboxes({
    db,
    teamName,
    site: creds.site,
    standaloneBot:
      agentName && standaloneClient ? { name: agentName, client: standaloneClient } : undefined,
    inboxName: agentName ? STANDALONE_INBOX_NAME : undefined,
    getSession: manager.getSession,
    onLog: log,
    onError: (err) => log(`backfill error: ${getErrorMessage(err)}`),
  }).catch((err) => log(`backfill failed: ${getErrorMessage(err)}`))
}

// Start event listeners now if credentials are available, or later when they're loaded
if (ctx.credentials.isConfigured()) {
  bootEventListeners()
} else {
  log('Zulip credentials not configured — waiting for init tool to load them.')
  ctx.credentials.onCredentialsLoaded(bootEventListeners)
}

server.server.onerror = (err) => log(`MCP server error: ${getErrorMessage(err)}`)

const transport = new StdioServerTransport()
transport.onerror = (err) => log(`MCP transport error: ${getErrorMessage(err)}`)
transport.onclose = () => log('MCP transport closed')
await server.connect(transport)
const tReady = performance.now()
log(`ready in ${(tReady - t0).toFixed(0)}ms`)
