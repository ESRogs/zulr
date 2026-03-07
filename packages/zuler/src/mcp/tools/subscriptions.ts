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
import { errorResult, type ToolContext, textResult } from '../helpers.ts'

export function registerSubscribeTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx.config

  server.registerTool(
    'subscribe',
    {
      description: 'Subscribe a teammate to a stream or a specific stream/topic.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        stream: z.string().describe('Stream name'),
        topic: z.string().optional().describe('Topic name (omit for whole-stream subscription)'),
      }),
    },
    async ({ sender, stream, topic }) => {
      const result = topic
        ? await addTopicSubscription(db, sender, stream, topic)
        : await addStreamSubscription(db, sender, stream)

      return result.match(
        () => textResult(`subscribed to ${topic ? `${stream}/${topic}` : stream}`),
        (err) => errorResult(`error: ${err.message}`),
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
        sender: z.string().describe('Teammate name'),
        stream: z.string().describe('Stream name'),
        topic: z.string().optional().describe('Topic name (omit for stream-level unsubscribe)'),
        all: z
          .boolean()
          .optional()
          .default(false)
          .describe('Remove stream and all topic subscriptions'),
      }),
    },
    async ({ sender, stream, topic, all }) => {
      const result = all
        ? await removeAllStreamSubscriptions(db, sender, stream)
        : topic
          ? await removeTopicSubscription(db, sender, stream, topic)
          : await removeStreamSubscription(db, sender, stream)

      const target = all ? `${stream} (all)` : topic ? `${stream}/${topic}` : stream
      return result.match(
        () => textResult(`unsubscribed from ${target}`),
        (err) => errorResult(`error: ${err.message}`),
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
        sender: z.string().describe('Teammate name'),
      }),
    },
    async ({ sender }) => {
      const result = await getTeammate(db, sender)
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
        (err) => errorResult(`error: ${err.message}`),
      )
    },
  )
}
