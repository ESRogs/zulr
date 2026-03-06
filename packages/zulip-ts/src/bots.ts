import type { ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from './client.ts'
import {
  type CreateBotResponse,
  CreateBotResponseSchema,
  type GetBotsResponse,
  GetBotsResponseSchema,
} from './schemas.ts'

export function getBots(client: ZulipClient): ResultAsync<GetBotsResponse, ZulipError> {
  return client.request({ method: 'GET', path: '/bots' }, GetBotsResponseSchema)
}

export type CreateBotParams = {
  readonly fullName: string
  readonly shortName: string
  readonly botType?: number
}

export function createBot(
  client: ZulipClient,
  params: CreateBotParams,
): ResultAsync<CreateBotResponse, ZulipError> {
  return client.request(
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
  )
}
