import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type GetStreamsResponse,
  GetStreamsResponseSchema,
  type SubscribeResponse,
  SubscribeResponseSchema,
} from './schemas.ts'

export function getStreams(client: ZulipClient): ResultAsync<GetStreamsResponse, ZulipError> {
  return client.request({ method: 'GET', path: '/streams' }, GetStreamsResponseSchema)
}

export function subscribe(
  client: ZulipClient,
  streams: readonly { readonly name: string }[],
): ResultAsync<SubscribeResponse, ZulipError> {
  return client.request(
    {
      method: 'POST',
      path: '/users/me/subscriptions',
      body: { subscriptions: streams },
    },
    SubscribeResponseSchema,
  )
}
