import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type CreateChannelResponse,
  CreateChannelResponseSchema,
  type GetStreamsResponse,
  GetStreamsResponseSchema,
  type GetTopicsResponse,
  GetTopicsResponseSchema,
  type SubscribeResponse,
  SubscribeResponseSchema,
  type SuccessResponse,
  SuccessResponseSchema,
  type UpdateChannelResponse,
  UpdateChannelResponseSchema,
} from './schemas.ts'

export function getStreams(client: ZulipClient): ResultAsync<GetStreamsResponse, ZulipError> {
  return client.request({ method: 'GET', path: '/streams' }, GetStreamsResponseSchema)
}

export function getTopics(
  client: ZulipClient,
  streamId: number,
): ResultAsync<GetTopicsResponse, ZulipError> {
  return client.request(
    { method: 'GET', path: `/users/me/${streamId}/topics` },
    GetTopicsResponseSchema,
  )
}

export type CreateChannelParams = {
  readonly name: string
  readonly description?: string
  readonly subscribers: readonly number[]
}

export function createChannel(
  client: ZulipClient,
  params: CreateChannelParams,
): ResultAsync<CreateChannelResponse, ZulipError> {
  return client.request(
    {
      method: 'POST',
      path: '/channels/create',
      body: {
        name: params.name,
        subscribers: params.subscribers,
        ...(params.description !== undefined ? { description: params.description } : {}),
      },
    },
    CreateChannelResponseSchema,
  )
}

export type UpdateChannelParams = {
  readonly newName?: string
  readonly description?: string
}

export function updateChannel(
  client: ZulipClient,
  streamId: number,
  params: UpdateChannelParams,
): ResultAsync<UpdateChannelResponse, ZulipError> {
  const body: Record<string, unknown> = {}
  if (params.newName !== undefined) body.new_name = params.newName
  if (params.description !== undefined) body.description = params.description
  return client.request(
    { method: 'PATCH', path: `/streams/${streamId}`, body },
    UpdateChannelResponseSchema,
  )
}

export function archiveStream(
  client: ZulipClient,
  streamId: number,
): ResultAsync<SuccessResponse, ZulipError> {
  return client.request({ method: 'DELETE', path: `/streams/${streamId}` }, SuccessResponseSchema)
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
