import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type GetMessagesResponse,
  GetMessagesResponseSchema,
  type SendMessageResponse,
  SendMessageResponseSchema,
  type SuccessResponse,
  SuccessResponseSchema,
  type UpdateMessageFlagsResponse,
  UpdateMessageFlagsResponseSchema,
  type UpdateMessageResponse,
  UpdateMessageResponseSchema,
} from './schemas.ts'
import type { MessageId, StreamId, UserId } from './tagged-types.ts'

export type SendDirectMessageParams = {
  readonly to: readonly UserId[]
  readonly content: string
}

export type SendStreamMessageParams = {
  readonly to: string
  readonly topic: string
  readonly content: string
}

export function sendDirectMessage(
  client: ZulipClient,
  params: SendDirectMessageParams,
): ResultAsync<SendMessageResponse, ZulipError> {
  return client.request(
    {
      method: 'POST',
      path: '/messages',
      body: {
        type: 'direct',
        to: params.to,
        content: params.content,
      },
    },
    SendMessageResponseSchema,
  )
}

export function sendStreamMessage(
  client: ZulipClient,
  params: SendStreamMessageParams,
): ResultAsync<SendMessageResponse, ZulipError> {
  return client.request(
    {
      method: 'POST',
      path: '/messages',
      body: {
        type: 'stream',
        to: params.to,
        subject: params.topic,
        content: params.content,
      },
    },
    SendMessageResponseSchema,
  )
}

export type NarrowFilter = {
  readonly operator: string
  readonly operand: string | number | readonly number[]
}

export type GetMessagesParams = {
  readonly anchor: 'newest' | 'oldest' | 'first_unread' | MessageId
  readonly numBefore: number
  readonly numAfter: number
  readonly narrow: readonly NarrowFilter[]
  readonly applyMarkdown?: boolean
}

/** Mark messages as read (or other flag) for the authenticated user. */
export function updateMessageFlags(
  client: ZulipClient,
  messageIds: readonly MessageId[],
  op: 'add' | 'remove',
  flag: string,
): ResultAsync<UpdateMessageFlagsResponse, ZulipError> {
  return client.request(
    {
      method: 'POST',
      path: '/messages/flags',
      body: {
        messages: messageIds,
        op,
        flag,
      },
    },
    UpdateMessageFlagsResponseSchema,
  )
}

/** Mark specific messages as read for the authenticated user. */
export function markAsRead(
  client: ZulipClient,
  messageIds: readonly MessageId[],
): ResultAsync<UpdateMessageFlagsResponse, ZulipError> {
  return updateMessageFlags(client, messageIds, 'add', 'read')
}

export type UpdateMessageParams = {
  readonly content?: string
  readonly topic?: string
  readonly streamId?: StreamId
  readonly propagateMode?: 'change_one' | 'change_later' | 'change_all'
  readonly sendNotificationToOldThread?: boolean
  readonly sendNotificationToNewThread?: boolean
}

export function updateMessage(
  client: ZulipClient,
  messageId: MessageId,
  params: UpdateMessageParams,
): ResultAsync<UpdateMessageResponse, ZulipError> {
  const body: Record<string, unknown> = {}
  if (params.content !== undefined) body.content = params.content
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

export function addReaction(
  client: ZulipClient,
  messageId: MessageId,
  emojiName: string,
): ResultAsync<SuccessResponse, ZulipError> {
  return client.request(
    { method: 'POST', path: `/messages/${messageId}/reactions`, body: { emoji_name: emojiName } },
    SuccessResponseSchema,
  )
}

export function removeReaction(
  client: ZulipClient,
  messageId: MessageId,
  emojiName: string,
): ResultAsync<SuccessResponse, ZulipError> {
  return client.request(
    {
      method: 'DELETE',
      path: `/messages/${messageId}/reactions`,
      body: { emoji_name: emojiName },
    },
    SuccessResponseSchema,
  )
}

export function getMessages(
  client: ZulipClient,
  params: GetMessagesParams,
): ResultAsync<GetMessagesResponse, ZulipError> {
  return client.request(
    {
      method: 'GET',
      path: '/messages',
      params: {
        anchor: String(params.anchor),
        num_before: params.numBefore,
        num_after: params.numAfter,
        narrow: JSON.stringify(params.narrow),
        apply_markdown: params.applyMarkdown ?? false,
      },
    },
    GetMessagesResponseSchema,
  )
}
