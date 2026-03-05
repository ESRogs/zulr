import type { ResultAsync } from 'neverthrow';
import type { ZulipClient, ZulipError } from './client.ts';
import {
  GetEventsResponseSchema,
  RegisterQueueResponseSchema,
  type GetEventsResponse,
  type RegisterQueueResponse,
} from './schemas.ts';

export type RegisterQueueParams = {
  readonly eventTypes: readonly string[];
  readonly narrow?: readonly [string, string][];
};

export const registerQueue = (
  client: ZulipClient,
  params: RegisterQueueParams,
): ResultAsync<RegisterQueueResponse, ZulipError> =>
  client.request(
    {
      method: 'POST',
      path: '/register',
      body: {
        event_types: params.eventTypes,
        ...(params.narrow ? { narrow: params.narrow } : {}),
      },
    },
    RegisterQueueResponseSchema,
  );

export type GetEventsParams = {
  readonly queueId: string;
  readonly lastEventId: number;
};

export const getEvents = (
  client: ZulipClient,
  params: GetEventsParams,
): ResultAsync<GetEventsResponse, ZulipError> =>
  client.request(
    {
      method: 'GET',
      path: '/events',
      params: {
        queue_id: params.queueId,
        last_event_id: params.lastEventId,
      },
    },
    GetEventsResponseSchema,
  );
