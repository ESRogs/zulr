import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  addStreamSubscription,
  addTopicSubscription,
  removeAllStreamSubscriptions,
  removeStreamSubscription,
  removeTopicSubscription,
} from '../../state/subscriptions.ts'
import { getTeammate } from '../../state/teammates.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerSubscribeTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx.config

  server.registerTool(
    'subscribe',
    {
      description: 'Subscribe a teammate to a channel or a specific channel/topic.',
      inputSchema: z.object({
        teammate: z.string().describe('Teammate name'),
        channel: z.string().describe('Channel name'),
        topic: z.string().optional().describe('Topic name (omit for whole-channel subscription)'),
      }),
    },
    async ({ teammate, channel, topic }) => {
      const result = topic
        ? await addTopicSubscription(db, teammate, channel, topic)
        : await addStreamSubscription(db, teammate, channel)

      return result.match(
        () => textResult(`subscribed to ${topic ? `${channel}/${topic}` : channel}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerUnsubscribeTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx.config

  server.registerTool(
    'unsubscribe',
    {
      description:
        'Unsubscribe a teammate from a channel, a specific topic, or all subscriptions in a channel.',
      inputSchema: z.object({
        teammate: z.string().describe('Teammate name'),
        channel: z.string().describe('Channel name'),
        topic: z.string().optional().describe('Topic name (omit for channel-level unsubscribe)'),
        all: z
          .union([z.boolean(), z.string().transform((s) => s === 'true')])
          .optional()
          .default(false)
          .describe('Remove channel and all topic subscriptions'),
      }),
    },
    async ({ teammate, channel, topic, all }) => {
      const result = all
        ? await removeAllStreamSubscriptions(db, teammate, channel)
        : topic
          ? await removeTopicSubscription(db, teammate, channel, topic)
          : await removeStreamSubscription(db, teammate, channel)

      const target = all ? `${channel} (all)` : topic ? `${channel}/${topic}` : channel
      return result.match(
        () => textResult(`unsubscribed from ${target}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerSubscriptionsTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx.config

  server.registerTool(
    'subscriptions',
    {
      description: "List a teammate's current channel and topic subscriptions.",
      inputSchema: z.object({
        teammate: z.string().describe('Teammate name'),
      }),
    },
    async ({ teammate }) => {
      const result = await getTeammate(db, teammate)
      return result.match(
        (t) => {
          const lines = [
            ...(t.streamSubs.length > 0 ? ['channels:', ...t.streamSubs.map((s) => `  ${s}`)] : []),
            ...(t.topicSubs.length > 0
              ? ['topics:', ...t.topicSubs.map((sub) => `  ${sub.stream}/${sub.topic}`)]
              : []),
          ]
          return textResult(lines.length === 0 ? '(no subscriptions)' : lines.join('\n'))
        },
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
