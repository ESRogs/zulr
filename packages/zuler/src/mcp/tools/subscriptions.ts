import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getSubscriptions } from 'zulip-ts'
import {
  errorResult,
  formatError,
  type ToolContext,
  textResult,
  zTeammateName,
} from '../helpers.ts'

export function registerSubscriptionsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'subscriptions',
    {
      description: "List a teammate's current channel subscriptions on Zulip.",
      inputSchema: z.object({
        teammate: zTeammateName.describe('Teammate name'),
      }),
    },
    async ({ teammate }) => {
      const clientResult = await ctx.getTeammateClient(teammate)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const result = await getSubscriptions(clientResult.value.client)
      return result.match(
        (res) => {
          if (res.subscriptions.length === 0) return textResult('(no subscriptions)')
          const lines = res.subscriptions
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map((s) => `  ${s.name}`)
          return textResult(`channels:\n${lines.join('\n')}`)
        },
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
