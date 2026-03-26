import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerBot } from '../../bot-manager.ts'
import {
  errorResult,
  formatError,
  notConfiguredResult,
  type ToolContext,
  textResult,
  zTeammateName,
} from '../helpers.ts'

export function registerRegisterTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'register',
    {
      description:
        'Register a teammate: create or look up a Zulip bot and store credentials. Idempotent — safe to call again if already registered.',
      inputSchema: z.object({
        name: zTeammateName.describe('Teammate name'),
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
