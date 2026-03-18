import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { updateSettings } from 'zulip-ts'
import { registerBot } from '../../bot-manager.ts'
import {
  errorResult,
  formatError,
  notConfiguredResult,
  type ToolContext,
  textResult,
} from '../helpers.ts'

export function registerRegisterTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'register',
    {
      description:
        'Register a teammate: create or look up a Zulip bot and store credentials. Idempotent — safe to call again if already registered.',
      inputSchema: z.object({
        name: z.string().describe('Teammate name'),
      }),
    },
    async ({ name }) => {
      const adminClient = ctx.getAdminClient()
      if (!adminClient) {
        return notConfiguredResult()
      }
      const result = await registerBot(adminClient, ctx.config.db, name)
      if (result.isOk()) {
        ctx.invalidateMembersCache()

        // Set sensible defaults on the bot's Zulip account
        const botClientResult = await ctx.getTeammateClient(name)
        if (botClientResult.isOk()) {
          await updateSettings(botClientResult.value.client, {
            automatically_follow_topics_where_mentioned: true,
            automatically_follow_topics_policy: 2, // topics the bot sends a message to
          })
        }

        // Start an event listener for this bot
        const manager = ctx.getEventListenerManager()
        if (manager) {
          await manager.startBot(name)
        }
      }
      return result.match(
        (info) => textResult(`registered '${name}' (${info.botEmail})`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
