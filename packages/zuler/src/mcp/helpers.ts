import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import type { Member, ZulipClient } from 'zulip-ts'
import { createClient, getMembers } from 'zulip-ts'
import { clientForTeammate } from '../bot-manager.ts'
import type { ZulerDatabase } from '../state/db.ts'

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

/** Format any error type consistently for MCP tool responses. */
export function formatError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return JSON.stringify(err)
}

export type ServerConfig = {
  readonly db: Kysely<ZulerDatabase>
  readonly teamName: string
  readonly repoRoot: string
}

/** Shared context available to all tool handlers. */
export type ToolContext = {
  readonly config: ServerConfig
  /** Returns the admin client, or undefined if credentials aren't configured. */
  readonly getAdminClient: () => ZulipClient | undefined
  /** Get a ZulipClient for a registered teammate's bot. Checks credentials are configured. */
  readonly getTeammateClient: (sender: string) => ResultAsync<ZulipClient, string>
  /** Returns true if Zulip credentials are configured. */
  readonly isConfigured: () => boolean
  /** Returns Zulip credentials if configured. */
  readonly getCredentials: () => { site: string; email: string; apiKey: string } | undefined
  /**
   * Try to load credentials from .env file if not already configured.
   * If credentials become available, starts the event listener for inbound messages.
   */
  readonly tryLoadEnv: () => void
  /** Set the callback to start the event listener when credentials become available. */
  readonly onCredentialsLoaded: (callback: () => void) => void
  readonly isBot: (userId: number) => ResultAsync<boolean, string>
  /** Resolve a user by ID, full name, or email. Returns the Member if found. */
  readonly resolveUser: (identifier: string | number) => ResultAsync<Member, string>
  readonly invalidateMembersCache: () => void
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

function getZulipCredentials(): { site: string; email: string; apiKey: string } | undefined {
  const site = process.env.ZULIP_SITE
  const email = process.env.ZULIP_EMAIL
  const apiKey = process.env.ZULIP_API_KEY
  if (!site || !email || !apiKey) return undefined
  return { site, email, apiKey }
}

export function createToolContext(config: ServerConfig): ToolContext {
  let adminClient: ZulipClient | undefined
  let membersCache: Map<number, Member> | null = null

  function tryGetClient(): ZulipClient | undefined {
    if (adminClient) return adminClient
    const creds = getZulipCredentials()
    if (!creds) return undefined
    adminClient = createClient(creds)
    return adminClient
  }

  function refreshMembersCache(): ResultAsync<Map<number, Member>, string> {
    const client = tryGetClient()
    if (!client) return errAsync(NOT_CONFIGURED_MESSAGE)
    return getMembers(client)
      .map((res) => {
        membersCache = new Map(res.members.map((m) => [m.user_id, m]))
        return membersCache
      })
      .mapErr((err) => `failed to fetch Zulip members: ${JSON.stringify(err)}`)
  }

  function getMember(userId: number): ResultAsync<Member | undefined, string> {
    const cached = membersCache?.get(userId)
    if (cached) return okAsync(cached)

    return refreshMembersCache().andThen((cache) => {
      const member = cache.get(userId)
      if (member) return okAsync(member)
      return okAsync(undefined)
    })
  }

  function isBot(userId: number): ResultAsync<boolean, string> {
    return getMember(userId).andThen((member) => {
      if (!member) return errAsync(`unknown Zulip user ID: ${userId}`)
      return okAsync(member.is_bot ?? false)
    })
  }

  function resolveUser(identifier: string | number): ResultAsync<Member, string> {
    // MCP transport may serialize numbers as strings
    const asNumber = typeof identifier === 'number' ? identifier : Number(identifier)
    if (Number.isInteger(asNumber) && asNumber > 0) {
      return getMember(asNumber).andThen((member) =>
        member ? okAsync(member) : errAsync(`unknown Zulip user ID: ${asNumber}`),
      )
    }
    // Exact match — callers use canonical names/emails from Zulip's API
    function findInCache(cache: Map<number, Member>): Member | undefined {
      for (const m of cache.values()) {
        if (
          m.full_name === identifier ||
          m.email === identifier ||
          m.delivery_email === identifier
        )
          return m
      }
      return undefined
    }
    if (membersCache) {
      const found = findInCache(membersCache)
      if (found) return okAsync(found)
    }
    return refreshMembersCache().andThen((cache) => {
      const found = findInCache(cache)
      if (found) return okAsync(found)
      return errAsync(`no Zulip user found matching "${identifier}"`)
    })
  }

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
        if (!wasConfigured && !eventListenerStarted && credentialsLoadedCallback) {
          eventListenerStarted = true
          credentialsLoadedCallback()
        }
      }
    },
    onCredentialsLoaded: (callback: () => void) => {
      credentialsLoadedCallback = callback
    },
    getTeammateClient: (sender: string) => {
      const creds = getZulipCredentials()
      if (!creds) return errAsync(NOT_CONFIGURED_MESSAGE)
      return clientForTeammate(config.db, creds.site, sender).mapErr(formatError)
    },
    isBot,
    resolveUser,
    invalidateMembersCache: () => {
      membersCache = null
    },
  }
}
