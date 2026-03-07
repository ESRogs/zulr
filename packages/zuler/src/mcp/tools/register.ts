import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerBot } from '../../bot-manager.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'register',
    {
      description: 'Register a teammate: create or look up a Zulip bot and store credentials.',
      inputSchema: z.object({
        name: z.string().describe('Teammate name'),
      }),
    },
    async ({ name }) => {
      const result = await registerBot(ctx.adminClient, ctx.config.db, name)
      if (result.isOk()) {
        ctx.invalidateMembersCache()
      }
      return result.match(
        (info) => textResult(`registered '${name}' (${info.botEmail})`),
        (err) => errorResult(`error: ${formatError(err)}`),
      )
    },
  )
}
