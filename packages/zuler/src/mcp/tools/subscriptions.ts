import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getSubscriptions, subscribe, unsubscribe } from 'zulip-ts'
import {
  errorResult,
  formatError,
  type ToolContext,
  textResult,
  zChannelName,
  zTeammateName,
} from '../helpers.ts'

export function registerSubscribeTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'subscribe',
    {
      description:
        'Subscribe a teammate to a Zulip channel. To follow a specific topic, use the follow tool instead.',
      inputSchema: z.object({
        teammate: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
      }),
    },
    async ({ teammate, channel }) => {
      const clientResult = await ctx.getTeammateClient(teammate)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const result = await subscribe(clientResult.value.client, [{ name: channel }])
      return result.match(
        () => textResult(`subscribed to ${channel}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerUnsubscribeTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'unsubscribe',
    {
      description:
        'Unsubscribe a teammate from a Zulip channel. To unfollow a specific topic (keeping the channel subscription), use the unfollow tool instead.',
      inputSchema: z.object({
        teammate: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
      }),
    },
    async ({ teammate, channel }) => {
      const clientResult = await ctx.getTeammateClient(teammate)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const result = await unsubscribe(clientResult.value.client, [channel])
      return result.match(
        () => textResult(`unsubscribed from ${channel}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

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
