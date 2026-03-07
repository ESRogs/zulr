import type { Kysely } from 'kysely'
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
  readonly isBot: (userId: number) => Promise<{ isBot: boolean } | { error: string }>
  readonly invalidateMembersCache: () => void
}

export function createToolContext(config: ServerConfig): ToolContext {
  const adminClient = createClient({
    site: config.zulipSite,
    email: config.zulipEmail,
    apiKey: config.zulipApiKey,
  })

  let membersCache: Map<number, Member> | null = null

  async function refreshMembersCache(): Promise<Map<number, Member>> {
    const result = await getMembers(adminClient)
    if (result.isErr()) {
      throw new Error(`failed to fetch Zulip members: ${JSON.stringify(result.error)}`)
    }
    membersCache = new Map(result.value.members.map((m) => [m.user_id, m]))
    return membersCache
  }

  async function getMember(userId: number): Promise<Member | undefined> {
    const cache = membersCache ?? (await refreshMembersCache())
    const member = cache.get(userId)
    if (member) return member
    const fresh = await refreshMembersCache()
    return fresh.get(userId)
  }

  async function isBot(userId: number): Promise<{ isBot: boolean } | { error: string }> {
    try {
      const member = await getMember(userId)
      if (!member) return { error: `unknown Zulip user ID: ${userId}` }
      return { isBot: member.is_bot ?? false }
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) }
    }
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
