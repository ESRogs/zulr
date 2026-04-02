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
  if (err instanceof Error) return err.stack ?? err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    if ('message' in err && typeof (err as { message: unknown }).message === 'string') {
      return (err as { message: string }).message
    }
    return JSON.stringify(err)
  }
  return String(err)
}

/** Pick the most useful params for each tool to keep log lines concise. */
function summarizeToolParams(tool: string, params: Record<string, unknown>): string {
  const parts: string[] = []
  const pick = (key: string) => {
    if (params[key] !== undefined) parts.push(`${key}=${params[key]}`)
  }
  pick('sender')
  if (tool === 'post') {
    pick('channel')
    pick('topic')
    pick('to')
    if (typeof params.content === 'string') {
      const preview =
        params.content.length > 60 ? `${params.content.slice(0, 60)}...` : params.content
      parts.push(`content="${preview}"`)
    }
  } else if (tool === 'read' || tool === 'catch-up') {
    pick('channel')
    pick('topic')
  } else if (tool === 'search') {
    pick('query')
  } else if (tool === 'react') {
    pick('messageId')
    pick('emoji')
  } else if (tool === 'follow' || tool === 'unfollow' || tool === 'mute' || tool === 'unmute') {
    pick('channel')
    pick('topic')
  } else if (tool === 'register') {
    pick('name')
  } else {
    // For other tools, include all string/number params (skip long content)
    for (const [k, v] of Object.entries(params)) {
      if (k === 'sender') continue
      if (typeof v === 'string' && v.length > 80) continue
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        parts.push(`${k}=${v}`)
      }
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

ctx.setOnToolCall((name, params) => {
  const keyParams = summarizeToolParams(name, params)
  log(`tool:${name}${keyParams ? ` ${keyParams}` : ''}`)
})

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
    onInboxWrite: (info) => {
      log(`[${info.botName}] inbox: ${info.summary}`)
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
const tReady = performance.now()
log(`ready in ${(tReady - t0).toFixed(0)}ms`)
