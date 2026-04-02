import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type {
  ApiKey,
  ChannelName,
  Email,
  EmojiName,
  Member,
  Stream,
  TopicName,
  UserId,
  ZulipClient,
} from 'zulip-ts'
import { createClient, getMembers, getStreams } from 'zulip-ts'
import { clientForTeammate, type TeammateClient } from '../bot-manager.ts'
import type { ZulerDatabase } from '../state/db.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import type { EventListenerManager } from '../zulip/event-listener.ts'

/** Zod schema transforms that produce tagged types from MCP tool string inputs. */
export const zTeammateName = z.string().transform((s): TeammateName => s as TeammateName)
export const zChannelName = z.string().transform((s): ChannelName => s as ChannelName)
export const zTopicName = z.string().transform((s): TopicName => s as TopicName)
export const zEmojiName = z.string().transform((s): EmojiName => s as EmojiName)

/** MCP tool response helpers */
export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

const NOT_CONFIGURED_MESSAGE = 'Zulip credentials not configured. Call the init tool first.'

/** Error result for when Zulip credentials aren't configured. */
export function notConfiguredResult() {
  return errorResult(NOT_CONFIGURED_MESSAGE)
}

import { getErrorMessage } from '../errors.ts'

/** Format any error type consistently for MCP tool responses. */
export const formatError = getErrorMessage

/** Build a synchronous user ID → full_name resolver from the members cache. */
export function buildUserIdResolver(
  ctx: ToolContext,
): ResultAsync<(id: UserId) => string | undefined, string> {
  return ctx.getMembersMap().map((members) => (id: UserId) => members.get(id)?.full_name)
}

export type ServerConfig = {
  readonly db: Kysely<ZulerDatabase>
  readonly teamName: TeamName
  readonly repoRoot: string
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

type TimedCache<T> = {
  data: T
  fetchedAt: number
}

function isCacheValid<T>(cache: TimedCache<T> | null): cache is TimedCache<T> {
  return cache !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS
}

/** Shared context available to all tool handlers. */
export type ToolContext = {
  readonly config: ServerConfig
  /** Returns the admin client, or undefined if credentials aren't configured. */
  readonly getAdminClient: () => ZulipClient | undefined
  /** Get a ZulipClient and bot user ID for a registered teammate. Checks credentials are configured. */
  readonly getTeammateClient: (sender: TeammateName) => ResultAsync<TeammateClient, string>
  /** Returns true if Zulip credentials are configured. */
  readonly isConfigured: () => boolean
  /** Returns Zulip credentials if configured. */
  readonly getCredentials: () => { site: string; email: Email; apiKey: ApiKey } | undefined
  /**
   * Try to load credentials from .env file if not already configured.
   * If credentials become available, starts the event listener for inbound messages.
   */
  readonly tryLoadEnv: () => void
  /** Set the callback to start the event listener when credentials become available. */
  readonly onCredentialsLoaded: (callback: () => void) => void
  readonly isBot: (userId: UserId) => ResultAsync<boolean, string>
  /** Resolve a user by ID, full name, or email. Returns the Member if found. */
  readonly resolveUser: (identifier: string | number) => ResultAsync<Member, string>
  /** Resolve a channel name to a Stream object. */
  readonly resolveChannel: (name: string) => ResultAsync<Stream, string>
  /** List all channels (uses cache). */
  readonly listChannels: () => ResultAsync<readonly Stream[], string>
  /** Get the members map (user_id → Member), refreshing the cache if needed. */
  readonly getMembersMap: () => ResultAsync<ReadonlyMap<UserId, Member>, string>
  readonly invalidateMembersCache: () => void
  readonly invalidateChannelsCache: () => void
  /** Set the event listener manager (called from index.ts after boot). */
  readonly setEventListenerManager: (manager: EventListenerManager) => void
  /** Get the event listener manager, if set. */
  readonly getEventListenerManager: () => EventListenerManager | undefined
  /** Set a callback for when an MCP tool is invoked (for logging). */
  readonly setOnToolCall: (cb: (name: string, params: Record<string, unknown>) => void) => void
  /** Get the tool call callback, if set. */
  readonly getOnToolCall: () =>
    | ((name: string, params: Record<string, unknown>) => void)
    | undefined
}

/**
 * Parse a .env file and set any missing process.env vars.
 *
 * Bun loads .env at process start, but this is needed for the lazy-load case
 * where the .env file is created after the MCP server starts (during onboarding).
 *
 * Limitations: does not handle `export` prefix, multiline values, or escaped
 * quotes. Sufficient for the three well-known ZULIP_* vars.
 */
function loadEnvFile(repoRoot: string): boolean {
  const envPath = join(repoRoot, '.env')
  try {
    // readFileSync instead of Bun.file because this is called synchronously
    const content = readFileSync(envPath, 'utf-8')
    let loaded = false
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const eqIndex = trimmed.indexOf('=')
      const key = trimmed.slice(0, eqIndex).trim()
      const rawValue = trimmed.slice(eqIndex + 1).trim()
      // Strip surrounding quotes (single or double)
      const value = rawValue.replace(/^(['"])(.*)\1$/, '$2')
      if (key && !process.env[key]) {
        process.env[key] = value
        loaded = true
      }
    }
    return loaded
  } catch {
    return false
  }
}

function getZulipCredentials(): { site: string; email: Email; apiKey: ApiKey } | undefined {
  const site = process.env.ZULIP_SITE
  const email = process.env.ZULIP_EMAIL
  const apiKey = process.env.ZULIP_API_KEY
  if (!site || !email || !apiKey) return undefined
  if (!email.includes('@')) {
    throw new Error(`ZULIP_EMAIL is not a valid email address: ${email}`)
  }
  try {
    new URL(site)
  } catch {
    throw new Error(`ZULIP_SITE is not a valid URL: ${site}`)
  }
  return { site, email: email as Email, apiKey: apiKey as ApiKey }
}

export function createToolContext(config: ServerConfig): ToolContext {
  let adminClient: ZulipClient | undefined
  let membersCache: TimedCache<Map<UserId, Member>> | null = null
  let channelsCache: TimedCache<readonly Stream[]> | null = null
  let eventListenerManager: EventListenerManager | undefined

  function tryGetClient(): ZulipClient | undefined {
    if (adminClient) return adminClient
    const creds = getZulipCredentials()
    if (!creds) return undefined
    adminClient = createClient(creds)
    return adminClient
  }

  function refreshMembersCache(): ResultAsync<Map<UserId, Member>, string> {
    const client = tryGetClient()
    if (!client) return errAsync(NOT_CONFIGURED_MESSAGE)
    return getMembers(client)
      .map((res) => {
        const data = new Map(res.members.map((m) => [m.user_id, m]))
        membersCache = { data, fetchedAt: Date.now() }
        return data
      })
      .mapErr((err) => `failed to fetch Zulip members: ${JSON.stringify(err)}`)
  }

  function getMember(userId: UserId): ResultAsync<Member | undefined, string> {
    if (isCacheValid(membersCache)) {
      const cached = membersCache.data.get(userId)
      if (cached) return okAsync(cached)
    }

    return refreshMembersCache().andThen((cache) => {
      const member = cache.get(userId)
      if (member) return okAsync(member)
      return okAsync(undefined)
    })
  }

  function isBot(userId: UserId): ResultAsync<boolean, string> {
    return getMember(userId).andThen((member) => {
      if (!member) return errAsync(`unknown Zulip user ID: ${userId}`)
      return okAsync(member.is_bot ?? false)
    })
  }

  function resolveUser(identifier: string | number): ResultAsync<Member, string> {
    // MCP transport may serialize numbers as strings
    const asNumber = typeof identifier === 'number' ? identifier : Number(identifier)
    if (Number.isInteger(asNumber) && asNumber > 0) {
      const id = asNumber as UserId
      return getMember(id).andThen((member) =>
        member ? okAsync(member) : errAsync(`unknown Zulip user ID: ${id}`),
      )
    }
    // Exact match — callers use canonical names/emails from Zulip's API
    function findInCache(cache: Map<UserId, Member>): Member | undefined {
      for (const m of cache.values()) {
        if (m.full_name === identifier || m.email === identifier || m.delivery_email === identifier)
          return m
      }
      return undefined
    }
    if (isCacheValid(membersCache)) {
      const found = findInCache(membersCache.data)
      if (found) return okAsync(found)
    }
    return refreshMembersCache().andThen((cache) => {
      const found = findInCache(cache)
      if (found) return okAsync(found)
      return errAsync(`no Zulip user found matching "${identifier}"`)
    })
  }

  function refreshChannelsCache(): ResultAsync<readonly Stream[], string> {
    const client = tryGetClient()
    if (!client) return errAsync(NOT_CONFIGURED_MESSAGE)
    return getStreams(client)
      .map((res) => {
        channelsCache = { data: res.streams, fetchedAt: Date.now() }
        return res.streams
      })
      .mapErr((err) => `failed to fetch channels: ${JSON.stringify(err)}`)
  }

  function resolveChannel(name: string): ResultAsync<Stream, string> {
    function findInList(streams: readonly Stream[]): Stream | undefined {
      return streams.find((s) => s.name === name)
    }
    if (isCacheValid(channelsCache)) {
      const found = findInList(channelsCache.data)
      if (found) return okAsync(found)
    }
    return refreshChannelsCache().andThen((streams) => {
      const found = findInList(streams)
      if (found) return okAsync(found)
      return errAsync(`channel "${name}" not found`)
    })
  }

  let onToolCallCallback: ((name: string, params: Record<string, unknown>) => void) | undefined
  let credentialsLoadedCallback: (() => void) | null = null
  let eventListenerStarted = false

  return {
    config,
    getAdminClient: tryGetClient,
    isConfigured: () => !!getZulipCredentials(),
    getCredentials: getZulipCredentials,
    tryLoadEnv: () => {
      const wasConfigured = !!getZulipCredentials()
      const loaded = loadEnvFile(config.repoRoot)
      if (loaded && getZulipCredentials()) {
        adminClient = undefined
        membersCache = null
        channelsCache = null
        if (!wasConfigured && !eventListenerStarted && credentialsLoadedCallback) {
          eventListenerStarted = true
          credentialsLoadedCallback()
        }
      }
    },
    onCredentialsLoaded: (callback: () => void) => {
      credentialsLoadedCallback = callback
    },
    getTeammateClient: (sender: TeammateName) => {
      const creds = getZulipCredentials()
      if (!creds) return errAsync(NOT_CONFIGURED_MESSAGE)
      return clientForTeammate(config.db, creds.site, sender).mapErr(formatError)
    },
    isBot,
    resolveUser,
    resolveChannel,
    getMembersMap: () => {
      if (isCacheValid(membersCache))
        return okAsync(membersCache.data as ReadonlyMap<UserId, Member>)
      return refreshMembersCache().map((data) => data as ReadonlyMap<UserId, Member>)
    },
    listChannels: () => {
      if (isCacheValid(channelsCache)) return okAsync(channelsCache.data)
      return refreshChannelsCache()
    },
    invalidateMembersCache: () => {
      membersCache = null
    },
    invalidateChannelsCache: () => {
      channelsCache = null
    },
    setEventListenerManager: (manager: EventListenerManager) => {
      eventListenerManager = manager
    },
    getEventListenerManager: () => eventListenerManager,
    setOnToolCall: (cb) => {
      onToolCallCallback = cb
    },
    getOnToolCall: () => onToolCallCallback,
  }
}
