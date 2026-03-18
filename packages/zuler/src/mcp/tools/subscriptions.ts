import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getSubscriptions, setUserTopic, subscribe, TopicVisibility, unsubscribe } from 'zulip-ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerSubscribeTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'subscribe',
    {
      description:
        'Subscribe a teammate to a channel, or follow a specific topic within a channel the teammate is already subscribed to.',
      inputSchema: z.object({
        teammate: z.string().describe('Teammate name'),
        channel: z.string().describe('Channel name'),
        topic: z
          .string()
          .optional()
          .describe('Topic name (follow this topic — requires channel subscription)'),
      }),
    },
    async ({ teammate, channel, topic }) => {
      const clientResult = await ctx.getTeammateClient(teammate)
      if (clientResult.isErr()) return errorResult(clientResult.error)
      const { client } = clientResult.value

      if (topic) {
        // Follow a specific topic — bot must already be subscribed to the channel.
        // Resolve channel to stream_id first.
        const channelResult = await ctx.resolveChannel(channel)
        if (channelResult.isErr()) return errorResult(channelResult.error)

        const result = await setUserTopic(
          client,
          channelResult.value.stream_id,
          topic,
          TopicVisibility.FOLLOWED,
        )
        return result.match(
          () => textResult(`following ${channel}/${topic}`),
          (err) => errorResult(formatError(err)),
        )
      }

      const result = await subscribe(client, [{ name: channel }])
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
        'Unsubscribe a teammate from a channel, or unfollow a specific topic within a channel.',
      inputSchema: z.object({
        teammate: z.string().describe('Teammate name'),
        channel: z.string().describe('Channel name'),
        topic: z
          .string()
          .optional()
          .describe('Topic name (unfollow this topic — keeps channel subscription)'),
      }),
    },
    async ({ teammate, channel, topic }) => {
      const clientResult = await ctx.getTeammateClient(teammate)
      if (clientResult.isErr()) return errorResult(clientResult.error)
      const { client } = clientResult.value

      if (topic) {
        const channelResult = await ctx.resolveChannel(channel)
        if (channelResult.isErr()) return errorResult(channelResult.error)

        const result = await setUserTopic(
          client,
          channelResult.value.stream_id,
          topic,
          TopicVisibility.INHERIT,
        )
        return result.match(
          () => textResult(`unfollowed ${channel}/${topic}`),
          (err) => errorResult(formatError(err)),
        )
      }

      const result = await unsubscribe(client, [channel])
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
        teammate: z.string().describe('Teammate name'),
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
