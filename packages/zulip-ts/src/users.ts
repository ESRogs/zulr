import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import { type GetMembersResponse, GetMembersResponseSchema } from './schemas.ts'

export function getMembers(client: ZulipClient): ResultAsync<GetMembersResponse, ZulipError> {
  return client.request({ method: 'GET', path: '/users' }, GetMembersResponseSchema)
}
