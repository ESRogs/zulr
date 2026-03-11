import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type GetStreamsResponse,
  GetStreamsResponseSchema,
  type GetTopicsResponse,
  GetTopicsResponseSchema,
  type SubscribeResponse,
  SubscribeResponseSchema,
  type UpdateMessageResponse,
  UpdateMessageResponseSchema,
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

export type UpdateMessageParams = {
  readonly topic?: string
  readonly streamId?: number
  readonly propagateMode?: 'change_one' | 'change_later' | 'change_all'
  readonly sendNotificationToOldThread?: boolean
  readonly sendNotificationToNewThread?: boolean
}

export function updateMessage(
  client: ZulipClient,
  messageId: number,
  params: UpdateMessageParams,
): ResultAsync<UpdateMessageResponse, ZulipError> {
  const body: Record<string, unknown> = {}
  if (params.topic !== undefined) body.topic = params.topic
  if (params.streamId !== undefined) body.stream_id = params.streamId
  if (params.propagateMode !== undefined) body.propagate_mode = params.propagateMode
  if (params.sendNotificationToOldThread !== undefined)
    body.send_notification_to_old_thread = params.sendNotificationToOldThread
  if (params.sendNotificationToNewThread !== undefined)
    body.send_notification_to_new_thread = params.sendNotificationToNewThread
  return client.request(
    { method: 'PATCH', path: `/messages/${messageId}`, body },
    UpdateMessageResponseSchema,
  )
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
