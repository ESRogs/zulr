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
      description: 'Subscribe a teammate to a stream or a specific stream/topic.',
      inputSchema: z.object({
        teammate: z.string().describe('Teammate name'),
        stream: z.string().describe('Stream name'),
        topic: z.string().optional().describe('Topic name (omit for whole-stream subscription)'),
      }),
    },
    async ({ teammate, stream, topic }) => {
      const result = topic
        ? await addTopicSubscription(db, teammate, stream, topic)
        : await addStreamSubscription(db, teammate, stream)

      return result.match(
        () => textResult(`subscribed to ${topic ? `${stream}/${topic}` : stream}`),
        (err) => errorResult(`error: ${formatError(err)}`),
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
        'Unsubscribe a teammate from a stream, a specific topic, or all subscriptions in a stream.',
      inputSchema: z.object({
        teammate: z.string().describe('Teammate name'),
        stream: z.string().describe('Stream name'),
        topic: z.string().optional().describe('Topic name (omit for stream-level unsubscribe)'),
        all: z
          .boolean()
          .optional()
          .default(false)
          .describe('Remove stream and all topic subscriptions'),
      }),
    },
    async ({ teammate, stream, topic, all }) => {
      const result = all
        ? await removeAllStreamSubscriptions(db, teammate, stream)
        : topic
          ? await removeTopicSubscription(db, teammate, stream, topic)
          : await removeStreamSubscription(db, teammate, stream)

      const target = all ? `${stream} (all)` : topic ? `${stream}/${topic}` : stream
      return result.match(
        () => textResult(`unsubscribed from ${target}`),
        (err) => errorResult(`error: ${formatError(err)}`),
      )
    },
  )
}

export function registerSubscriptionsTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx.config

  server.registerTool(
    'subscriptions',
    {
      description: "List a teammate's current stream and topic subscriptions.",
      inputSchema: z.object({
        teammate: z.string().describe('Teammate name'),
      }),
    },
    async ({ teammate }) => {
      const result = await getTeammate(db, teammate)
      return result.match(
        (t) => {
          const lines = [
            ...(t.streamSubs.length > 0 ? ['streams:', ...t.streamSubs.map((s) => `  ${s}`)] : []),
            ...(t.topicSubs.length > 0
              ? ['topics:', ...t.topicSubs.map((sub) => `  ${sub.stream}/${sub.topic}`)]
              : []),
          ]
          return textResult(lines.length === 0 ? '(no subscriptions)' : lines.join('\n'))
        },
        (err) => errorResult(`error: ${formatError(err)}`),
      )
    },
  )
}
