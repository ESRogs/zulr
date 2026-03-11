import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type GetMembersResponse,
  GetMembersResponseSchema,
  type SuccessResponse,
  SuccessResponseSchema,
} from './schemas.ts'

export function getMembers(client: ZulipClient): ResultAsync<GetMembersResponse, ZulipError> {
  return client.request({ method: 'GET', path: '/users' }, GetMembersResponseSchema)
}

export type UpdateStatusParams = {
  readonly statusText?: string
  readonly emojiName?: string
}

export function updateStatus(
  client: ZulipClient,
  params: UpdateStatusParams,
): ResultAsync<SuccessResponse, ZulipError> {
  const body: Record<string, unknown> = {}
  if (params.statusText !== undefined) body.status_text = params.statusText
  if (params.emojiName !== undefined) body.emoji_name = params.emojiName
  return client.request({ method: 'POST', path: '/users/me/status', body }, SuccessResponseSchema)
}
