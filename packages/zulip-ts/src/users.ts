import type { ResultAsync } from 'neverthrow';
import type { ZulipClient, ZulipError } from './client.ts';
import {
  GetMembersResponseSchema,
  type GetMembersResponse,
} from './schemas.ts';

export const getMembers = (
  client: ZulipClient,
): ResultAsync<GetMembersResponse, ZulipError> =>
  client.request(
    { method: 'GET', path: '/users' },
    GetMembersResponseSchema,
  );
