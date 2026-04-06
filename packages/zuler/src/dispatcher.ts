/**
 * Dispatcher: a lightweight service that watches Zulip for messages directed
 * at stopped mngr agents and wakes them up via `mngr start`.
 *
 * Creates a ZulipSession per managed bot using each bot's API key. When a
 * notification-worthy event arrives (DM, @-mention, followed topic), checks
 * if the target agent is stopped and calls `mngr start` to wake it.
 *
 * Usage: ZULER_REPO_ROOT=/path/to/repo bun run packages/zuler/src/dispatcher.ts
 */

import { createClient, type ZulipClient } from 'zulip-ts'
import { createSession, type ZulipSession } from 'zulip-client-ts'
import { openDatabase } from './state/db.ts'
import { listTeammates, type Teammate } from './state/teammates.ts'
import { getErrorMessage } from './errors.ts'
import type { TeammateName } from './tagged-types.ts'

const SESSION_EVENT_TYPES = [
  'message',
  'user_topic',
  'realm_user',
  'reaction',
  'subscription',
] as const

type AgentStatus = 'running' | 'stopped' | 'unknown'

type DispatcherOptions = {
  /** Zulip server URL. */
  readonly site: string
  /** Map of agent names to their mngr agent names (if different from bot names). */
  readonly agentNameMap?: ReadonlyMap<TeammateName, string>
  /** Polling interval for agent status checks (ms). Default: 30000. */
  readonly statusPollIntervalMs?: number
  /** Called when an agent is woken up. */
  readonly onWake?: (agentName: string, reason: string) => void
  /** Called on errors. */
  readonly onError?: (err: unknown) => void
  /** Called for general logging. */
  readonly onLog?: (msg: string) => void
}

/** Query mngr for the status of all agents. */
async function getMngrAgentStatuses(): Promise<Map<string, AgentStatus>> {
  const statuses = new Map<string, AgentStatus>()
  try {
    const proc = Bun.spawn(['mngr', 'list', '--format', 'json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const data = JSON.parse(text)
    const agents = data.agents ?? data ?? []
    for (const agent of agents) {
      const name = agent.name ?? agent.agent_name
      const state = agent.state ?? agent.status
      if (name) {
        statuses.set(name, state === 'running' ? 'running' : 'stopped')
      }
    }
  } catch {
    // If mngr isn't available, return empty map
  }
  return statuses
}

/** Wake a stopped agent via `mngr start`. */
async function wakeAgent(agentName: string, onLog?: (msg: string) => void): Promise<boolean> {
  try {
    onLog?.(`waking agent '${agentName}'...`)
    const proc = Bun.spawn(['mngr', 'start', agentName], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    if (exitCode === 0) {
      onLog?.(`agent '${agentName}' started successfully`)
      return true
    }
    const stderr = await new Response(proc.stderr).text()
    onLog?.(`failed to start '${agentName}': ${stderr.trim()}`)
    return false
  } catch (err) {
    onLog?.(`error starting '${agentName}': ${getErrorMessage(err)}`)
    return false
  }
}

/** Create and run the dispatcher. Returns a stop function. */
export function createDispatcher(
  teammates: readonly Teammate[],
  options: DispatcherOptions,
): { stop: () => void } {
  const { site, onWake, onError, onLog } = options
  const statusPollIntervalMs = options.statusPollIntervalMs ?? 30_000

  const sessions: Map<TeammateName, ZulipSession> = new Map()
  const abortController = new AbortController()

  // Cache of agent statuses, refreshed periodically
  let agentStatuses: Map<string, AgentStatus> = new Map()

  // Cooldown: don't wake the same agent within 60s
  const wakeCooldowns: Map<string, number> = new Map()
  const WAKE_COOLDOWN_MS = 60_000

  function getMngrName(botName: TeammateName): string {
    return options.agentNameMap?.get(botName) ?? botName
  }

  function isAgentStopped(botName: TeammateName): boolean {
    const mngrName = getMngrName(botName)
    const status = agentStatuses.get(mngrName)
    return status === 'stopped'
  }

  function isOnCooldown(botName: TeammateName): boolean {
    const mngrName = getMngrName(botName)
    const lastWake = wakeCooldowns.get(mngrName)
    if (!lastWake) return false
    return Date.now() - lastWake < WAKE_COOLDOWN_MS
  }

  async function tryWake(botName: TeammateName, reason: string): Promise<void> {
    const mngrName = getMngrName(botName)
    if (!isAgentStopped(botName)) return
    if (isOnCooldown(botName)) {
      onLog?.(`skipping wake for '${mngrName}' (cooldown)`)
      return
    }

    wakeCooldowns.set(mngrName, Date.now())
    const success = await wakeAgent(mngrName, onLog)
    if (success) {
      onWake?.(mngrName, reason)
      // Update cached status
      agentStatuses.set(mngrName, 'running')
    }
  }

  // Periodically refresh agent statuses
  const statusPoller = setInterval(async () => {
    try {
      agentStatuses = await getMngrAgentStatuses()
    } catch (err) {
      onError?.(err)
    }
  }, statusPollIntervalMs)

  // Start a session per bot
  function startBotWatcher(teammate: Teammate): void {
    const client: ZulipClient = createClient({
      site,
      email: teammate.botEmail,
      apiKey: teammate.apiKey,
    })

    const session = createSession({
      client,
      eventTypes: [...SESSION_EVENT_TYPES],
      allPublicStreams: true,
      signal: abortController.signal,
      handler: {
        onNotification: (_event, result) => {
          if (result.shouldNotify) {
            // Fire and forget — don't block the event loop
            tryWake(teammate.name, result.reason).catch((err) => onError?.(err))
          }
        },
        onError: (err) => {
          onLog?.(`[${teammate.name}] session error: ${typeof err === 'string' ? err : getErrorMessage(err)}`)
        },
      },
    })

    sessions.set(teammate.name, session)

    // Start the session (runs the event loop)
    session.start().then(
      () => onLog?.(`[${teammate.name}] session exited`),
      (err: unknown) => {
        onLog?.(`[${teammate.name}] session failed: ${getErrorMessage(err)}`)
        onError?.(err)
      },
    )
  }

  // Initialize
  async function init(): Promise<void> {
    agentStatuses = await getMngrAgentStatuses()
    onLog?.(`initial agent statuses: ${JSON.stringify(Object.fromEntries(agentStatuses))}`)

    for (const teammate of teammates) {
      onLog?.(`starting watcher for ${teammate.name}`)
      startBotWatcher(teammate)
    }

    onLog?.(`dispatcher running — watching ${teammates.length} bot(s)`)
  }

  init().catch((err) => onError?.(err))

  return {
    stop: () => {
      clearInterval(statusPoller)
      abortController.abort()
      for (const session of sessions.values()) {
        session.stop()
      }
      sessions.clear()
      onLog?.('dispatcher stopped')
    },
  }
}

// --- CLI entry point ---
if (import.meta.main) {
  const repoRoot = process.env.ZULER_REPO_ROOT ?? process.cwd()
  const site = process.env.ZULIP_SITE

  if (!site) {
    console.error('ZULIP_SITE environment variable is required')
    process.exit(1)
  }

  const db = openDatabase(repoRoot)
  const teammatesResult = await listTeammates(db)

  if (teammatesResult.isErr()) {
    console.error(`failed to load teammates: ${getErrorMessage(teammatesResult.error)}`)
    process.exit(1)
  }

  const teammates = teammatesResult.value
  if (teammates.length === 0) {
    console.error('no teammates registered — nothing to watch')
    process.exit(1)
  }

  console.log(`zuler dispatcher starting — watching ${teammates.length} bot(s) on ${site}`)

  const dispatcher = createDispatcher(teammates, {
    site,
    onWake: (name, reason) => console.log(`[wake] ${name} — ${reason}`),
    onError: (err) => console.error(`[error] ${getErrorMessage(err)}`),
    onLog: (msg) => console.log(`[dispatcher] ${msg}`),
  })

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nshutting down...')
    dispatcher.stop()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    dispatcher.stop()
    process.exit(0)
  })
}
