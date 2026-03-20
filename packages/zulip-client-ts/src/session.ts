import { err, ok, type Result } from 'neverthrow'
import type {
  Event,
  EventId,
  MessageId,
  StreamId,
  TopicName,
  UserId,
  ZulipClient,
  ZulipError,
} from 'zulip-ts'
import { getEvents, registerQueue } from 'zulip-ts'
import {
  applyFlagsEvent,
  applyMessageEvent,
  emptyUnreadState,
  getUnreadCount,
  getUnreadDmCount,
  getUnreadMessageIds,
  hasUnreadDms,
  hasUnreads,
  initUnreadState,
  type UnreadState,
} from './unread-state.ts'

const RETRY_DELAY_MS = 5000

export type SessionEventHandler = {
  /** Called for every event received from the queue. */
  readonly onEvent?: (event: Event) => void
  /** Called on errors (network, API, validation). Session continues after errors. */
  readonly onError?: (error: ZulipError | string) => void
}

export type ZulipSession = {
  // Unread state (streams)
  readonly getUnreadCount: (streamId: StreamId, topic: TopicName) => number
  readonly getUnreadMessageIds: (streamId: StreamId, topic: TopicName) => readonly MessageId[]
  readonly hasUnreads: (streamId: StreamId, topic: TopicName) => boolean

  // Unread state (DMs)
  readonly getUnreadDmCount: (userId: UserId) => number
  readonly hasUnreadDms: (userId: UserId) => boolean

  // Lifecycle
  readonly start: () => Promise<void>
  readonly stop: () => void

  // For testing: direct access to unread state
  readonly getState: () => UnreadState
}

export type CreateSessionParams = {
  readonly client: ZulipClient
  readonly eventTypes?: readonly string[]
  readonly handler?: SessionEventHandler
  readonly signal?: AbortSignal
}

export function createSession(params: CreateSessionParams): ZulipSession {
  const { client, eventTypes = ['message', 'update_message_flags'], handler, signal } = params

  let state: UnreadState = emptyUnreadState()
  let stopped = false

  async function start(): Promise<void> {
    stopped = false

    while (!stopped && !signal?.aborted) {
      const result = await runEventLoop()
      if (result.isErr()) {
        handler?.onError?.(result.error)
        if (!stopped && !signal?.aborted) {
          await sleep(RETRY_DELAY_MS, signal)
        }
      }
      // BAD_EVENT_QUEUE_ID or other loop exit — re-register
    }
  }

  async function runEventLoop(): Promise<Result<void, ZulipError | string>> {
    const regResult = await registerQueue(client, {
      eventTypes,
      fetchEventTypes: ['message'],
    })

    if (regResult.isErr()) return err(regResult.error)

    const { queue_id: queueId, last_event_id: initialLastEventId, unread_msgs } = regResult.value

    // Initialize unread state from the register response
    if (unread_msgs) {
      state = initUnreadState(unread_msgs)
    } else {
      state = emptyUnreadState()
    }

    let lastEventId: EventId = initialLastEventId

    while (!stopped && !signal?.aborted) {
      const eventsResult = await getEvents(client, { queueId, lastEventId })

      if (eventsResult.isErr()) {
        const evtErr = eventsResult.error
        if (evtErr.type === 'api' && evtErr.code === 'BAD_EVENT_QUEUE_ID') {
          // Queue expired — break to re-register
          return ok(undefined)
        }
        return err(evtErr)
      }

      for (const event of eventsResult.value.events) {
        lastEventId = event.id

        if (event.type === 'message') {
          applyMessageEvent(state, event)
        } else if (event.type === 'update_message_flags') {
          applyFlagsEvent(state, event)
        }

        handler?.onEvent?.(event)
      }
    }

    return ok(undefined)
  }

  function stop(): void {
    stopped = true
  }

  return {
    getUnreadCount: (streamId, topic) => getUnreadCount(state, streamId, topic),
    getUnreadMessageIds: (streamId, topic) => getUnreadMessageIds(state, streamId, topic),
    hasUnreads: (streamId, topic) => hasUnreads(state, streamId, topic),
    getUnreadDmCount: (userId) => getUnreadDmCount(state, userId),
    hasUnreadDms: (userId) => hasUnreadDms(state, userId),
    start,
    stop,
    getState: () => state,
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
