import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type GetMessagesResponse,
  GetMessagesResponseSchema,
  type SendMessageResponse,
  SendMessageResponseSchema,
} from './schemas.ts'

export type SendDirectMessageParams = {
  readonly to: readonly number[]
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
  readonly operand: string | number
}

export type GetMessagesParams = {
  readonly anchor: 'newest' | 'oldest' | number
  readonly numBefore: number
  readonly numAfter: number
  readonly narrow: readonly NarrowFilter[]
  readonly applyMarkdown?: boolean
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
