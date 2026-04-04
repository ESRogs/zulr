import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Kysely } from 'kysely'
import { errAsync, type ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type {
  ApiKey,
  ChannelName,
  Email,
  EmojiName,
  TopicName,
  UserId,
  ZulipClient,
} from 'zulip-ts'
import { createClient } from 'zulip-ts'
import { clientForTeammate, type TeammateClient } from '../bot-manager.ts'
import { getErrorMessage } from '../errors.ts'
import type { ZulerDatabase } from '../state/db.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import type { EventListenerManager } from '../zulip/event-listener.ts'
import { type CacheContext, createCacheContext, NOT_CONFIGURED_MESSAGE } from './cache.ts'

/** Zod schema transforms that produce tagged types from MCP tool string inputs. */
export const zTeammateName = z.string().transform((s): TeammateName => s as TeammateName)
export const zChannelName = z.string().transform((s): ChannelName => s as ChannelName)
export const zTopicName = z.string().transform((s): TopicName => s as TopicName)
export const zEmojiName = z.string().transform((s): EmojiName => s as EmojiName)

/** Boolean schema that accepts string "true"/"false" from MCP transport. Produces `{ type: "boolean" }` in JSON Schema. */
export const zBool = z.preprocess((v) => (typeof v === 'string' ? v === 'true' : v), z.boolean())

/** MCP tool response helpers */
export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

export { NOT_CONFIGURED_MESSAGE } from './cache.ts'

/** Error result for when Zulip credentials aren't configured. */
export function notConfiguredResult() {
  return errorResult(NOT_CONFIGURED_MESSAGE)
}

export { getErrorMessage }

/** Thin wrapper around McpServer.registerTool that intercepts calls for instrumentation. */
export type ToolRegistrar = { readonly registerTool: McpServer['registerTool'] }

/**
 * Wrap a McpServer's registerTool method with a callback that fires on each tool invocation.
 *
 * The casts through `unknown` are intentional: McpServer.registerTool has a complex generic
 * signature that cannot be precisely wrapped without duplicating SDK internals.
 */
export function createToolRegistrar(server: McpServer, ctx: ToolContext): ToolRegistrar {
  return {
    registerTool: ((name: string, config: unknown, cb: (...args: unknown[]) => unknown) => {
      const wrappedCb = (...args: unknown[]) => {
        const params = (args[0] ?? {}) as Record<string, unknown>
        ctx.getOnToolCall()?.(name, params)
        return cb(...args)
      }
      return (
        server.registerTool as (n: string, c: unknown, f: (...a: unknown[]) => unknown) => unknown
      )(name, config, wrappedCb)
    }) as McpServer['registerTool'],
  }
}

/** Build a synchronous user ID → full_name resolver from the members cache. */
export function buildUserIdResolver(
  ctx: ToolContext,
): ResultAsync<(id: UserId) => string | undefined, string> {
  return ctx.cache.getMembersMap().map((members) => (id: UserId) => members.get(id)?.full_name)
}

export type ServerConfig = {
  readonly db: Kysely<ZulerDatabase>
  readonly teamName: TeamName
  readonly repoRoot: string
}

/** Shared context available to all tool handlers. */
export type ToolContext = {
  readonly config: ServerConfig
  /** Cached members and channels lookups. */
  readonly cache: CacheContext
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
  let eventListenerManager: EventListenerManager | undefined

  function tryGetClient(): ZulipClient | undefined {
    if (adminClient) return adminClient
    const creds = getZulipCredentials()
    if (!creds) return undefined
    adminClient = createClient(creds)
    return adminClient
  }

  const cache = createCacheContext(tryGetClient)

  let onToolCallCallback: ((name: string, params: Record<string, unknown>) => void) | undefined
  let credentialsLoadedCallback: (() => void) | null = null
  let eventListenerStarted = false

  return {
    config,
    cache,
    getAdminClient: tryGetClient,
    isConfigured: () => !!getZulipCredentials(),
    getCredentials: getZulipCredentials,
    tryLoadEnv: () => {
      const wasConfigured = !!getZulipCredentials()
      const loaded = loadEnvFile(config.repoRoot)
      if (loaded && getZulipCredentials()) {
        adminClient = undefined
        cache.invalidateMembersCache()
        cache.invalidateChannelsCache()
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
      return clientForTeammate(config.db, creds.site, sender).mapErr(getErrorMessage)
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
