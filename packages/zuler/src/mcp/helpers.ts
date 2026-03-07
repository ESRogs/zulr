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

/** Format any error type consistently for MCP tool responses. */
export function formatError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return JSON.stringify(err)
}

export type ServerConfig = {
  readonly db: Kysely<ZulerDatabase>
  readonly zulipSite: string
  readonly zulipEmail: string
  readonly zulipApiKey: string
  readonly teamName: string
}

/** Shared context available to all tool handlers. */
export type ToolContext = {
  readonly config: ServerConfig
  readonly adminClient: ZulipClient
  readonly isBot: (userId: number) => ResultAsync<boolean, string>
  readonly invalidateMembersCache: () => void
}

export function createToolContext(config: ServerConfig): ToolContext {
  const adminClient = createClient({
    site: config.zulipSite,
    email: config.zulipEmail,
    apiKey: config.zulipApiKey,
  })

  let membersCache: Map<number, Member> | null = null

  function refreshMembersCache(): ResultAsync<Map<number, Member>, string> {
    return getMembers(adminClient)
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
      // Still not found after refresh
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
    adminClient,
    isBot,
    invalidateMembersCache: () => {
      membersCache = null
    },
  }
}
