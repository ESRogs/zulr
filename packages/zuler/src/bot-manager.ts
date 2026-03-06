import { ResultAsync, okAsync, errAsync } from 'neverthrow'
import type { Kysely } from 'kysely'
import type { ZulipClient, ZulipError } from 'zulip-ts'
import { getBots, createBot, getStreams, subscribe, createClient } from 'zulip-ts'
import type { ZulerDatabase } from './db.ts'
import { registerTeammate, getTeammate } from './state.ts'
import type { StateError } from './state.ts'

export type BotManagerError =
  | { readonly type: 'zulip'; readonly inner: ZulipError }
  | { readonly type: 'state'; readonly inner: StateError }

const wrapZulip = (e: ZulipError): BotManagerError => ({ type: 'zulip', inner: e })
const wrapState = (e: StateError): BotManagerError => ({ type: 'state', inner: e })

/** Derive bot email from teammate name and Zulip site URL. */
export const botEmail = (name: string, site: string): string => {
  const host = new URL(site).hostname
  return `${name}-bot@${host}`
}

/** Find an existing bot by email, returning its API key if found. */
const findExistingBot = (
  adminClient: ZulipClient,
  email: string,
): ResultAsync<string | undefined, BotManagerError> =>
  getBots(adminClient)
    .map((res) => {
      const bot = res.bots.find((b) => b.username === email)
      return bot?.api_key
    })
    .mapErr(wrapZulip)

/** Create a new bot and return its API key. */
const createNewBot = (
  adminClient: ZulipClient,
  name: string,
): ResultAsync<string, BotManagerError> =>
  createBot(adminClient, {
    fullName: name,
    shortName: name,
  })
    .map((res) => res.api_key)
    .mapErr(wrapZulip)

/** Subscribe a bot to all streams so it can receive events. */
const subscribeToAllStreams = (
  botClient: ZulipClient,
  adminClient: ZulipClient,
): ResultAsync<void, BotManagerError> =>
  getStreams(adminClient)
    .mapErr(wrapZulip)
    .andThen((res) => {
      const streams = res.streams.map((s) => ({ name: s.name }))
      if (streams.length === 0) return okAsync(undefined)
      return subscribe(botClient, streams)
        .map(() => undefined)
        .mapErr(wrapZulip)
    })

/**
 * Register a teammate: find or create their Zulip bot, store credentials
 * in the database, and subscribe the bot to all streams.
 */
export const registerBot = (
  adminClient: ZulipClient,
  db: Kysely<ZulerDatabase>,
  name: string,
): ResultAsync<{ readonly botEmail: string; readonly apiKey: string }, BotManagerError> => {
  const email = botEmail(name, adminClient.config.site)

  // Check if already registered in our DB
  return ResultAsync.fromPromise(
    getTeammate(db, name),
    (e): BotManagerError => wrapState({ type: 'db_error', message: String(e) }),
  ).andThen((stateResult) => {
    if (stateResult.isOk()) {
      const existing = stateResult.value
      return okAsync({ botEmail: existing.botEmail, apiKey: existing.apiKey })
    }

    // Not in DB — find or create on Zulip
    return findExistingBot(adminClient, email).andThen((existingKey) => {
      const apiKeyResult = existingKey
        ? okAsync<string, BotManagerError>(existingKey)
        : createNewBot(adminClient, name)

      return apiKeyResult.andThen((apiKey) => {
        // Store in DB
        return ResultAsync.fromPromise(
          registerTeammate(db, { name, botEmail: email, apiKey }),
          (e): BotManagerError => wrapState({ type: 'db_error', message: String(e) }),
        ).andThen((regResult) => {
          if (regResult.isErr()) {
            return errAsync<{ botEmail: string; apiKey: string }, BotManagerError>(
              wrapState(regResult.error),
            )
          }

          // Subscribe bot to all streams
          const botClient = createClient({
            site: adminClient.config.site,
            email,
            apiKey,
          })

          return subscribeToAllStreams(botClient, adminClient)
            .map(() => ({ botEmail: email, apiKey }))
        })
      })
    })
  })
}

/** Create a ZulipClient for a registered teammate's bot. */
export const clientForTeammate = (
  db: Kysely<ZulerDatabase>,
  site: string,
  name: string,
): ResultAsync<ZulipClient, BotManagerError> =>
  ResultAsync.fromPromise(
    getTeammate(db, name),
    (e): BotManagerError => wrapState({ type: 'db_error', message: String(e) }),
  ).andThen((result) => {
    if (result.isErr()) {
      return errAsync<ZulipClient, BotManagerError>(wrapState(result.error))
    }
    const teammate = result.value
    return okAsync(createClient({
      site,
      email: teammate.botEmail,
      apiKey: teammate.apiKey,
    }))
  })
