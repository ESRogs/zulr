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

export function updateSettings(
  client: ZulipClient,
  settings: Record<string, unknown>,
): ResultAsync<SuccessResponse, ZulipError> {
  return client.request(
    { method: 'PATCH', path: '/settings', body: settings },
    SuccessResponseSchema,
  )
}
