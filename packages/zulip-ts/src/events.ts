import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type GetEventsResponse,
  GetEventsResponseSchema,
  type RegisterQueueResponse,
  RegisterQueueResponseSchema,
} from './schemas.ts'
import type { EventId, QueueId } from './tagged-types.ts'

export type RegisterQueueParams = {
  readonly eventTypes: readonly string[]
  readonly narrow?: readonly [string, string][]
  /** Event types whose initial state to include in the response (e.g. ['subscription', 'message']). */
  readonly fetchEventTypes?: readonly string[]
  /** If true, receive events for all public channels, not just subscribed ones. */
  readonly allPublicStreams?: boolean
}

export function registerQueue(
  client: ZulipClient,
  params: RegisterQueueParams,
): ResultAsync<RegisterQueueResponse, ZulipError> {
  return client.request(
    {
      method: 'POST',
      path: '/register',
      body: {
        event_types: params.eventTypes,
        ...(params.narrow ? { narrow: params.narrow } : {}),
        ...(params.fetchEventTypes ? { fetch_event_types: params.fetchEventTypes } : {}),
        ...(params.allPublicStreams ? { all_public_streams: true } : {}),
      },
    },
    RegisterQueueResponseSchema,
  )
}

export type GetEventsParams = {
  readonly queueId: QueueId
  readonly lastEventId: EventId
}

export function getEvents(
  client: ZulipClient,
  params: GetEventsParams,
): ResultAsync<GetEventsResponse, ZulipError> {
  return client.request(
    {
      method: 'GET',
      path: '/events',
      params: {
        queue_id: params.queueId,
        last_event_id: params.lastEventId,
      },
    },
    GetEventsResponseSchema,
  )
}
