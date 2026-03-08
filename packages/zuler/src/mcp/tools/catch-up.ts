import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { markAsRead } from 'zulip-ts'
import { clientForTeammate } from '../../bot-manager.ts'
import { getTeammate } from '../../state/teammates.ts'
import { fetchMessages, formatMessages } from '../../zulip/message-reader.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerCatchUpTool(server: McpServer, ctx: ToolContext): void {
  const { db, zulipSite } = ctx.config

  server.registerTool(
    'catch-up',
    {
      description:
        "Fetch unread messages from all subscribed streams/topics. Uses Zulip's per-bot read tracking, so it returns messages the teammate hasn't seen yet. Marks them as read after fetching. Useful after restart or context compaction.",
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        maxMessages: z
          .number()
          .optional()
          .default(25)
          .describe(
            'Maximum total messages to return (default: 25). Returns the most recent if more are available.',
          ),
      }),
    },
    async ({ sender, maxMessages }) => {
      const teammateResult = await getTeammate(db, sender)
      if (teammateResult.isErr()) {
        return errorResult(`error: ${teammateResult.error.message}`)
      }

      const teammate = teammateResult.value

      const botClientResult = await clientForTeammate(db, zulipSite, sender)
      if (botClientResult.isErr()) {
        return errorResult(`error: ${formatError(botClientResult.error)}`)
      }
      const botClient = botClientResult.value

      const subs: { stream: string; topic?: string }[] = [
        ...teammate.streamSubs.map((stream) => ({ stream })),
        ...teammate.topicSubs.map(({ stream, topic }) => ({ stream, topic })),
      ]

      if (subs.length === 0) {
        return textResult('(no subscriptions)')
      }

      // Fetch unread messages from all subscriptions in parallel (without marking read yet)
      const fetchResults = await Promise.all(
        subs.map((sub) => {
          const narrow = [
            { operator: 'stream' as const, operand: sub.stream },
            ...(sub.topic ? [{ operator: 'topic' as const, operand: sub.topic }] : []),
          ]
          return fetchMessages(
            botClient,
            {
              anchor: 'first_unread',
              numBefore: 0,
              numAfter: maxMessages,
              narrow,
              applyMarkdown: false,
            },
            { markRead: false, streamFallback: sub.stream, topicFallback: sub.topic },
          )
        }),
      )

      const allMessages = fetchResults.flatMap((r) => (r.isOk() ? [...r.value] : []))
      const failedCount = fetchResults.filter((r) => r.isErr()).length

      // Sort by timestamp, take most recent maxMessages
      allMessages.sort((a, b) => a.timestamp - b.timestamp)
      const trimmed = allMessages.slice(-maxMessages)

      if (trimmed.length === 0) {
        return textResult('(no unread messages across your subscriptions)')
      }

      // Mark only the messages we're returning as read
      await markAsRead(
        botClient,
        trimmed.map((m) => m.id),
      )

      const warnings = [
        ...(allMessages.length > maxMessages
          ? [`Showing ${trimmed.length} of ${allMessages.length} unread messages (most recent).`]
          : []),
        ...(failedCount > 0 ? [`Warning: ${failedCount} subscription(s) failed to fetch.`] : []),
      ]
      const header = warnings.length > 0 ? `${warnings.join(' ')}\n\n` : ''

      return textResult(`${header}${formatMessages(trimmed, true)}`)
    },
  )
}
