import type { Kysely } from 'kysely'
import { errAsync, okAsync, ResultAsync } from 'neverthrow'
import type { ZulipClient, ZulipError } from 'zulip-ts'
import { createBot, createClient, getBots, getStreams, subscribe } from 'zulip-ts'
import type { ZulerDatabase } from './state/db.ts'
import { getTeammate, registerTeammate, type StateError } from './state/teammates.ts'

export type BotManagerError =
  | { readonly type: 'zulip'; readonly inner: ZulipError }
  | { readonly type: 'state'; readonly inner: StateError }

const wrapZulip = (e: ZulipError): BotManagerError => ({ type: 'zulip', inner: e })
const wrapState = (e: StateError): BotManagerError => ({ type: 'state', inner: e })

/** Derive bot email from teammate name and Zulip site URL. */
export function botEmail(name: string, site: string): string {
  const host = new URL(site).hostname
  return `${name}-bot@${host}`
}

type BotCredentials = { apiKey: string; userId: number | null }

/** Find an existing bot by email, returning its API key and user ID if found. */
function findExistingBot(
  adminClient: ZulipClient,
  email: string,
): ResultAsync<BotCredentials | undefined, BotManagerError> {
  return getBots(adminClient)
    .map((res) => {
      const bot = res.bots.find((b) => b.username === email)
      if (!bot) return undefined
      return { apiKey: bot.api_key, userId: bot.user_id ?? null }
    })
    .mapErr(wrapZulip)
}

/** Create a new bot and return its API key and user ID. */
function createNewBot(
  adminClient: ZulipClient,
  name: string,
): ResultAsync<BotCredentials, BotManagerError> {
  return createBot(adminClient, {
    fullName: name,
    shortName: name,
  })
    .map((res) => ({ apiKey: res.api_key, userId: res.user_id }))
    .mapErr(wrapZulip)
}

/** Subscribe a bot to all streams so it can receive events. */
function subscribeToAllStreams(
  botClient: ZulipClient,
  adminClient: ZulipClient,
): ResultAsync<void, BotManagerError> {
  return getStreams(adminClient)
    .mapErr(wrapZulip)
    .andThen((res) => {
      const streams = res.streams.map((s) => ({ name: s.name }))
      if (streams.length === 0) return okAsync(undefined)
      return subscribe(botClient, streams)
        .map(() => undefined)
        .mapErr(wrapZulip)
    })
}

/**
 * Register a teammate: find or create their Zulip bot, store credentials
 * in the database, and subscribe the bot to all streams.
 */
export function registerBot(
  adminClient: ZulipClient,
  db: Kysely<ZulerDatabase>,
  name: string,
): ResultAsync<{ readonly botEmail: string; readonly apiKey: string }, BotManagerError> {
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
    return findExistingBot(adminClient, email).andThen((existing) => {
      const credsResult = existing
        ? okAsync<BotCredentials, BotManagerError>(existing)
        : createNewBot(adminClient, name)

      return credsResult.andThen((creds) => {
        // Store in DB
        return ResultAsync.fromPromise(
          registerTeammate(db, {
            name,
            botEmail: email,
            apiKey: creds.apiKey,
            botUserId: creds.userId,
          }),
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
            apiKey: creds.apiKey,
          })

          return subscribeToAllStreams(botClient, adminClient).map(() => ({
            botEmail: email,
            apiKey: creds.apiKey,
          }))
        })
      })
    })
  })
}

/** Create a ZulipClient for a registered teammate's bot. */
export function clientForTeammate(
  db: Kysely<ZulerDatabase>,
  site: string,
  name: string,
): ResultAsync<ZulipClient, BotManagerError> {
  return ResultAsync.fromPromise(
    getTeammate(db, name),
    (e): BotManagerError => wrapState({ type: 'db_error', message: String(e) }),
  ).andThen((result) => {
    if (result.isErr()) {
      return errAsync<ZulipClient, BotManagerError>(wrapState(result.error))
    }
    const teammate = result.value
    return okAsync(
      createClient({
        site,
        email: teammate.botEmail,
        apiKey: teammate.apiKey,
      }),
    )
  })
}
