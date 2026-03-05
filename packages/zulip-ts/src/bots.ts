import type { ResultAsync } from 'neverthrow';
import type { ZulipClient, ZulipError } from './client.ts';
import {
  CreateBotResponseSchema,
  GetBotsResponseSchema,
  type CreateBotResponse,
  type GetBotsResponse,
} from './schemas.ts';

export const getBots = (
  client: ZulipClient,
): ResultAsync<GetBotsResponse, ZulipError> =>
  client.request(
    { method: 'GET', path: '/bots' },
    GetBotsResponseSchema,
  );

export type CreateBotParams = {
  readonly fullName: string;
  readonly shortName: string;
  readonly botType?: number;
};

export const createBot = (
  client: ZulipClient,
  params: CreateBotParams,
): ResultAsync<CreateBotResponse, ZulipError> =>
  client.request(
    {
      method: 'POST',
      path: '/bots',
      body: {
        full_name: params.fullName,
        short_name: params.shortName,
        bot_type: params.botType ?? 1,
      },
    },
    CreateBotResponseSchema,
  );
