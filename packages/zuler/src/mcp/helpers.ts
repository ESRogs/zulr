import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Kysely } from 'kysely'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import type { Member, ZulipClient } from 'zulip-ts'
import { createClient, getMembers } from 'zulip-ts'
import type { ZulerDatabase } from '../state/db.ts'

/** MCP tool response helpers */
export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

/** Error result for when Zulip credentials aren't configured. */
export function notConfiguredResult() {
  return errorResult('Zulip credentials not configured. Call the init tool first.')
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
  /** Returns the Zulip site URL, or undefined if not configured. */
  readonly getZulipSite: () => string | undefined
  /** Returns true if Zulip credentials are configured. */
  readonly isConfigured: () => boolean
  /** Try to load credentials from .env file. Returns true if newly loaded. */
  readonly tryLoadEnv: () => void
  readonly isBot: (userId: number) => ResultAsync<boolean, string>
  readonly invalidateMembersCache: () => void
}

/** Parse a .env file and set any missing process.env vars. */
function loadEnvFile(repoRoot: string): boolean {
  const envPath = join(repoRoot, '.env')
  try {
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

  function ensureClient(): ZulipClient | undefined {
    if (adminClient) return adminClient
    const creds = getZulipCredentials()
    if (!creds) return undefined
    adminClient = createClient(creds)
    return adminClient
  }

  function refreshMembersCache(): ResultAsync<Map<number, Member>, string> {
    const client = ensureClient()
    if (!client) return errAsync('Zulip credentials not configured')
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

  return {
    config,
    getAdminClient: ensureClient,
    getZulipSite: () => process.env.ZULIP_SITE,
    isConfigured: () => !!getZulipCredentials(),
    tryLoadEnv: () => {
      loadEnvFile(config.repoRoot)
      if (getZulipCredentials()) {
        // Reset client so it gets recreated with new credentials
        adminClient = undefined
        membersCache = null
      }
    },
    isBot,
    invalidateMembersCache: () => {
      membersCache = null
    },
  }
}
