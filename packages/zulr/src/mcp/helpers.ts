import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Kysely } from 'kysely'
import type { ResultAsync } from 'neverthrow'
import { err, ok, type Result } from 'neverthrow'
import { z } from 'zod'
import type { ApiKey, ChannelName, Email, EmojiName, TopicName, UserId } from 'zulip-ts'
import { createClient } from 'zulip-ts'
import { getErrorMessage } from '../errors.ts'
import type { ZulrDatabase } from '../state/db.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import type { EventListenerManager } from '../zulip/event-listener.ts'
import { type CacheContext, createCacheContext, NOT_CONFIGURED_MESSAGE } from './cache.ts'
import {
  type CredentialsContext,
  createCredentialsContext,
  type StandaloneCredentials,
} from './credentials.ts'

export type { CacheContext } from './cache.ts'
export { NOT_CONFIGURED_MESSAGE } from './cache.ts'
export type { CredentialsContext, StandaloneCredentials, ZulipCredentials } from './credentials.ts'

/** Read standalone bot credentials from env vars and build a single client. Throws if required vars are missing. */
function getStandaloneCredentials(agentName: TeammateName): StandaloneCredentials {
  const site = process.env.ZULIP_SITE
  const botEmail = process.env.ZULIP_BOT_EMAIL
  const botApiKey = process.env.ZULIP_BOT_API_KEY
  if (!site || !botEmail || !botApiKey) {
    throw new Error(
      'standalone mode (ZULR_AGENT set) requires ZULIP_SITE, ZULIP_BOT_EMAIL, and ZULIP_BOT_API_KEY env vars',
    )
  }
  const client = createClient({ site, email: botEmail as Email, apiKey: botApiKey as ApiKey })
  return { agentName, site, botEmail: botEmail as Email, botApiKey: botApiKey as ApiKey, client }
}

/** Zod schema transforms that produce tagged types from MCP tool string inputs. */
export const zTeammateName = z.string().transform((s): TeammateName => s as TeammateName)
export const zOptionalTeammateName = zTeammateName.optional()
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
        ctx.config.onToolCall?.(name, params)
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
  readonly db: Kysely<ZulrDatabase>
  readonly teamName: TeamName
  readonly repoRoot: string
  /** Called on each MCP tool invocation (for logging). */
  readonly onToolCall?: (name: string, params: Record<string, unknown>) => void
  /** Bot identity for standalone mode. When set, `sender` params default to this value. */
  readonly agentName?: TeammateName
}

/** Shared context available to all tool handlers. */
export type ToolContext = {
  readonly config: ServerConfig
  /** Cached members and channels lookups. */
  readonly cache: CacheContext
  /** Credential management and Zulip client access. */
  readonly credentials: CredentialsContext
  /** Set the event listener manager (called from index.ts after boot). */
  readonly setEventListenerManager: (manager: EventListenerManager) => void
  /** Get the event listener manager, if set. */
  readonly getEventListenerManager: () => EventListenerManager | undefined
}

/**
 * Resolve the sender for a tool call. Uses the explicit `sender` param if provided,
 * falls back to `ZULR_AGENT` in standalone mode.
 */
export function resolveSender(
  ctx: ToolContext,
  sender: TeammateName | undefined,
): Result<TeammateName, string> {
  if (sender) return ok(sender)
  if (ctx.config.agentName) return ok(ctx.config.agentName)
  return err('sender is required (set ZULR_AGENT env var for standalone mode)')
}

export function createToolContext(config: ServerConfig): ToolContext {
  let eventListenerManager: EventListenerManager | undefined

  const standalone: StandaloneCredentials | undefined = config.agentName
    ? getStandaloneCredentials(config.agentName)
    : undefined

  const credentials = createCredentialsContext(
    config.db,
    config.repoRoot,
    () => {
      cache.invalidateMembersCache()
      cache.invalidateChannelsCache()
    },
    standalone,
  )

  const cache = createCacheContext(credentials.getAdminClient)

  return {
    config,
    cache,
    credentials,
    setEventListenerManager: (manager: EventListenerManager) => {
      eventListenerManager = manager
    },
    getEventListenerManager: () => eventListenerManager,
  }
}
