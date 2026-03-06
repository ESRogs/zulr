import type { Kysely } from 'kysely'
import type { ZulipClient } from 'zulip-ts'
import { getEvents, registerQueue } from 'zulip-ts'
import type { ZulerDatabase } from './db.ts'
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

/**
 * Start listening for Zulip events and route inbound messages to
 * Claude Code teammate inbox files.
 *
 * Registers an event queue, then long-polls for events in a loop.
 * On queue expiration or errors, re-registers and continues.
 * Stops when the AbortSignal is aborted.
 */
export async function startEventListener(options: EventListenerOptions): Promise<void> {
  const { client, db, teamName, onRoute, onError, signal } = options

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
          const msg = event.message
          onRoute?.({
            stream: msg.type === 'stream' ? msg.display_recipient : undefined,
            topic: msg.type === 'stream' ? msg.subject : undefined,
            sender: msg.sender_full_name,
            deliveredTo: result.delivered.map((d) => d.teammate),
            autoSubscribed: result.autoSubscribed,
          })
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
