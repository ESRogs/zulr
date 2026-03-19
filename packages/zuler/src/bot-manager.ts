import type { Kysely } from 'kysely'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import type { ApiKey, DisplayName, Email, UserId, ZulipClient, ZulipError } from 'zulip-ts'
import { createBot, createClient, getBots, getMembers } from 'zulip-ts'
import type { ZulerDatabase } from './state/db.ts'
import {
  getTeammate,
  registerTeammate,
  type StateError,
  updateTeammateCredentials,
} from './state/teammates.ts'
import type { TeammateName } from './tagged-types.ts'

export type BotManagerError =
  | { readonly type: 'zulip'; readonly inner: ZulipError }
  | { readonly type: 'state'; readonly inner: StateError }
  | { readonly type: 'bot_deleted'; readonly message: string }

const wrapZulip = (e: ZulipError): BotManagerError => ({ type: 'zulip', inner: e })
const wrapState = (e: StateError): BotManagerError => ({ type: 'state', inner: e })

/** Derive bot email from teammate name and Zulip site URL. */
export function botEmail(name: TeammateName, site: string): Email {
  const host = new URL(site).hostname
  return `${name}-bot@${host}` as Email
}

type BotCredentials = {
  readonly apiKey: ApiKey
  readonly userId: UserId | null
  readonly email: Email
}

/**
 * Look up a bot's user_id from the members list (fallback when getBots doesn't return it).
 * Returns null if the bot isn't found — this is best-effort, not guaranteed.
 * Matches on `email` (not `delivery_email`) because bot emails are API emails, not real inboxes.
 */
function lookupBotUserId(
  adminClient: ZulipClient,
  botEmail: Email,
): ResultAsync<UserId | null, BotManagerError> {
  return getMembers(adminClient)
    .map((res) => {
      const member = res.members.find((m) => m.email === botEmail)
      return member?.user_id ?? null
    })
    .mapErr(wrapZulip)
}

/** Find an existing bot, preferring email match, falling back to full_name match for bots with a bot-pattern email on the same host. */
function findExistingBot(
  adminClient: ZulipClient,
  email: Email,
  name: TeammateName,
): ResultAsync<BotCredentials | undefined, BotManagerError> {
  const host = new URL(adminClient.config.site).hostname
  return getBots(adminClient)
    .mapErr(wrapZulip)
    .andThen((res) => {
      // Prefer exact email match, then full_name match
      const byEmail = res.bots.find((b) => b.username === email)
      const bot =
        byEmail ??
        res.bots.find(
          (b) => (b.full_name as string) === name && b.username.endsWith(`-bot@${host}`),
        )
      if (!bot) return okAsync(undefined)

      const creds: BotCredentials = {
        apiKey: bot.api_key,
        userId: bot.user_id ?? null,
        email: bot.username,
      }

      // getBots may not return user_id — fall back to members list
      if (creds.userId != null) return okAsync<BotCredentials | undefined, BotManagerError>(creds)
      return lookupBotUserId(adminClient, creds.email).map((userId) => ({
        ...creds,
        userId,
      }))
    })
}

/** Create a new bot and return its API key and user ID. */
function createNewBot(
  adminClient: ZulipClient,
  name: TeammateName,
): ResultAsync<BotCredentials, BotManagerError> {
  return createBot(adminClient, {
    fullName: name as string as DisplayName,
    shortName: name,
  })
    .map((res) => ({
      apiKey: res.api_key,
      userId: res.user_id,
      email: botEmail(name, adminClient.config.site),
    }))
    .mapErr(wrapZulip)
}

/**
 * Register a teammate: find or create their Zulip bot, store credentials
 * in the database.
 */
export function registerBot(
  adminClient: ZulipClient,
  db: Kysely<ZulerDatabase>,
  name: TeammateName,
): ResultAsync<{ readonly botEmail: Email; readonly apiKey: ApiKey }, BotManagerError> {
  const email = botEmail(name, adminClient.config.site)

  // Check if already registered in our DB
  return getTeammate(db, name)
    .mapErr(wrapState)
    .andThen((existing) => {
      // Verify credentials against Zulip and refresh if stale
      return findExistingBot(adminClient, existing.botEmail, name).andThen((zulipBot) => {
        if (!zulipBot) {
          return errAsync<{ botEmail: Email; apiKey: ApiKey }, BotManagerError>({
            type: 'bot_deleted',
            message: `bot '${name}' exists in the local DB but was not found on Zulip. It may have been deleted.`,
          })
        }
        // Refresh if API key changed, bot_user_id is missing, or user ID differs.
        // If Zulip returns null for userId, keep the DB value (don't downgrade from known to unknown).
        const needsUpdate =
          zulipBot.apiKey !== existing.apiKey ||
          zulipBot.email !== existing.botEmail ||
          existing.botUserId === null ||
          (zulipBot.userId !== null && zulipBot.userId !== existing.botUserId)
        if (needsUpdate) {
          return updateTeammateCredentials(db, name, {
            apiKey: zulipBot.apiKey,
            botUserId: zulipBot.userId ?? existing.botUserId,
            botEmail: zulipBot.email,
          })
            .mapErr(wrapState)
            .map(() => ({ botEmail: zulipBot.email, apiKey: zulipBot.apiKey }))
        }
        return okAsync({ botEmail: existing.botEmail, apiKey: existing.apiKey })
      })
    })
    .orElse((err) => {
      if (err.type !== 'state' || err.inner.type !== 'not_found') {
        return errAsync(err)
      }

      // Not in DB — find or create on Zulip
      return findExistingBot(adminClient, email, name).andThen((zulipCreds) => {
        const credsResult = zulipCreds
          ? okAsync<BotCredentials, BotManagerError>(zulipCreds)
          : createNewBot(adminClient, name)

        return credsResult.andThen((creds) =>
          registerTeammate(db, {
            name,
            botEmail: creds.email,
            apiKey: creds.apiKey,
            botUserId: creds.userId,
          })
            .mapErr(wrapState)
            .map(() => ({
              botEmail: creds.email,
              apiKey: creds.apiKey,
            })),
        )
      })
    })
}

export type TeammateClient = {
  readonly client: ZulipClient
  readonly botUserId: UserId | null
}

/** Create a ZulipClient for a registered teammate's bot. */
export function clientForTeammate(
  db: Kysely<ZulerDatabase>,
  site: string,
  name: TeammateName,
): ResultAsync<TeammateClient, BotManagerError> {
  return getTeammate(db, name)
    .mapErr(wrapState)
    .map((teammate) => ({
      client: createClient({
        site,
        email: teammate.botEmail,
        apiKey: teammate.apiKey,
      }),
      botUserId: teammate.botUserId,
    }))
}
