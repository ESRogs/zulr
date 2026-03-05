import type { ResultAsync } from 'neverthrow';
import type { ZulipClient, ZulipError } from './client.ts';
import {
  GetStreamsResponseSchema,
  SubscribeResponseSchema,
  type GetStreamsResponse,
  type SubscribeResponse,
} from './schemas.ts';

export const getStreams = (
  client: ZulipClient,
): ResultAsync<GetStreamsResponse, ZulipError> =>
  client.request(
    { method: 'GET', path: '/streams' },
    GetStreamsResponseSchema,
  );

export const subscribe = (
  client: ZulipClient,
  streams: readonly { readonly name: string }[],
): ResultAsync<SubscribeResponse, ZulipError> =>
  client.request(
    {
      method: 'POST',
      path: '/users/me/subscriptions',
      body: { subscriptions: streams },
    },
    SubscribeResponseSchema,
  );
