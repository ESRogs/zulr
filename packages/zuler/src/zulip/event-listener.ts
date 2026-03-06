import type { Kysely } from 'kysely'
import type { ZulipClient } from 'zulip-ts'
import { getEvents, markAsRead, registerQueue } from 'zulip-ts'
import { clientForTeammate } from '../bot-manager.ts'
import type { ZulerDatabase } from '../state/db.ts'
import { routeMessage } from './routing.ts'

type EventListenerOptions = {
  readonly client: ZulipClient
  readonly db: Kysely<ZulerDatabase>
  readonly teamName: string
  /** Called on each successfully routed message for logging/debugging. */
  readonly onRoute?: (info: {
    readonly stream?: string
    readonly topic?: string
    readonly sender: string
    readonly deliveredTo: readonly string[]
    readonly autoSubscribed: readonly {
      readonly teammate: string
      readonly stream: string
      readonly topic: string
    }[]
  }) => void
  /** Called on errors for logging. Listener continues after errors. */
  readonly onError?: (error: unknown) => void
  /** If set, the listener stops when this signal is aborted. */
  readonly signal?: AbortSignal
}

const RETRY_DELAY_MS = 5000

/** Cache of per-bot ZulipClients, keyed by teammate name. */
type BotClientCache = Map<string, ZulipClient>

/** Get or create a cached bot client for a teammate. */
async function getCachedBotClient(
  cache: BotClientCache,
  db: Kysely<ZulerDatabase>,
  site: string,
  name: string,
  onError?: (error: unknown) => void,
): Promise<ZulipClient | undefined> {
  const cached = cache.get(name)
  if (cached) return cached

  const result = await clientForTeammate(db, site, name)
  if (result.isErr()) {
    onError?.(result.error)
    return undefined
  }

  cache.set(name, result.value)
  return result.value
}

/**
 * Mark a message as read for each teammate that received it,
 * using their cached bot clients. Runs in parallel.
 */
async function markReadForTeammates(
  cache: BotClientCache,
  db: Kysely<ZulerDatabase>,
  site: string,
  messageId: number,
  teammateNames: readonly string[],
  onError?: (error: unknown) => void,
): Promise<void> {
  await Promise.all(
    teammateNames.map(async (name) => {
      const botClient = await getCachedBotClient(cache, db, site, name, onError)
      if (!botClient) return
      const result = await markAsRead(botClient, [messageId])
      if (result.isErr()) {
        onError?.(result.error)
      }
    }),
  )
}

/**
 * Start listening for Zulip events and route inbound messages to
 * Claude Code teammate inbox files.
 *
 * Registers an event queue, then long-polls for events in a loop.
 * On queue expiration or errors, re-registers and continues.
 * Stops when the AbortSignal is aborted.
 *
 * After delivering a message to a teammate's inbox, marks it as read
 * on Zulip using the teammate's bot API key, so that catch-up via
 * "first_unread" anchor works correctly after restart.
 */
export async function startEventListener(options: EventListenerOptions): Promise<void> {
  const { client, db, teamName, onRoute, onError, signal } = options
  const botClientCache: BotClientCache = new Map()

  while (!signal?.aborted) {
    // Register a new event queue
    const regResult = await registerQueue(client, { eventTypes: ['message'] })

    if (regResult.isErr()) {
      onError?.(regResult.error)
      await sleep(RETRY_DELAY_MS, signal)
      continue
    }

    const { queue_id: queueId, last_event_id: initialLastEventId } = regResult.value
    let lastEventId = initialLastEventId

    // Poll loop for this queue
    while (!signal?.aborted) {
      const eventsResult = await getEvents(client, { queueId, lastEventId })

      if (eventsResult.isErr()) {
        const err = eventsResult.error
        // BAD_EVENT_QUEUE_ID means the queue expired — break to re-register
        if (err.type === 'api' && err.code === 'BAD_EVENT_QUEUE_ID') {
          break
        }
        onError?.(err)
        await sleep(RETRY_DELAY_MS, signal)
        continue
      }

      for (const event of eventsResult.value.events) {
        lastEventId = event.id

        if (event.type !== 'message' || !event.message) continue

        const result = await routeMessage(db, teamName, event.message)

        if (result.delivered.length > 0) {
          const deliveredNames = result.delivered.map((d) => d.teammate)
          const msg = event.message
          onRoute?.({
            stream: msg.type === 'stream' ? msg.display_recipient : undefined,
            topic: msg.type === 'stream' ? msg.subject : undefined,
            sender: msg.sender_full_name,
            deliveredTo: deliveredNames,
            autoSubscribed: result.autoSubscribed,
          })

          // Mark as read for each teammate (cache populates on miss)
          await markReadForTeammates(
            botClientCache,
            db,
            client.config.site,
            result.messageId,
            deliveredNames,
            onError,
          )
        }
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
