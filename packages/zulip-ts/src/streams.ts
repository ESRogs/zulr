import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type CreateChannelResponse,
  CreateChannelResponseSchema,
  type GetStreamsResponse,
  GetStreamsResponseSchema,
  type GetSubscriptionsResponse,
  GetSubscriptionsResponseSchema,
  type GetTopicsResponse,
  GetTopicsResponseSchema,
  type SubscribeResponse,
  SubscribeResponseSchema,
  type SuccessResponse,
  SuccessResponseSchema,
  type UnsubscribeResponse,
  UnsubscribeResponseSchema,
  type UpdateChannelResponse,
  UpdateChannelResponseSchema,
} from './schemas.ts'
import type { StreamId, UserId } from './tagged-types.ts'

export function getStreams(client: ZulipClient): ResultAsync<GetStreamsResponse, ZulipError> {
  return client.request({ method: 'GET', path: '/streams' }, GetStreamsResponseSchema)
}

export function getTopics(
  client: ZulipClient,
  streamId: StreamId,
): ResultAsync<GetTopicsResponse, ZulipError> {
  return client.request(
    { method: 'GET', path: `/users/me/${streamId}/topics` },
    GetTopicsResponseSchema,
  )
}

export type CreateChannelParams = {
  readonly name: string
  readonly description?: string
  readonly subscribers: readonly UserId[]
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
  streamId: StreamId,
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
  streamId: StreamId,
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

export function unsubscribe(
  client: ZulipClient,
  streams: readonly string[],
): ResultAsync<UnsubscribeResponse, ZulipError> {
  return client.request(
    {
      method: 'DELETE',
      path: '/users/me/subscriptions',
      body: { subscriptions: streams },
    },
    UnsubscribeResponseSchema,
  )
}

export function getSubscriptions(
  client: ZulipClient,
): ResultAsync<GetSubscriptionsResponse, ZulipError> {
  return client.request(
    { method: 'GET', path: '/users/me/subscriptions' },
    GetSubscriptionsResponseSchema,
  )
}

export type UserTopicVisibility = 0 | 1 | 2 | 3

/** Named constants for UserTopicVisibility values. */
export const TopicVisibility = {
  /** Inherit channel-level notification settings. */
  INHERIT: 0,
  /** Mute this topic. */
  MUTED: 1,
  /** Unmute this topic (overrides channel mute). */
  UNMUTED: 2,
  /** Follow this topic (get notifications for all messages). */
  FOLLOWED: 3,
} as const satisfies Record<string, UserTopicVisibility>

export function setUserTopic(
  client: ZulipClient,
  streamId: StreamId,
  topic: string,
  visibilityPolicy: UserTopicVisibility,
): ResultAsync<SuccessResponse, ZulipError> {
  return client.request(
    {
      method: 'POST',
      path: '/user_topics',
      body: { stream_id: streamId, topic, visibility_policy: visibilityPolicy },
    },
    SuccessResponseSchema,
  )
}
