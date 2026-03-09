import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { markAsRead } from 'zulip-ts'
import { clientForTeammate } from '../../bot-manager.ts'
import { fetchMessages, formatMessages } from '../../zulip/message-reader.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerReadTool(server: McpServer, ctx: ToolContext): void {
  const { db, zulipSite } = ctx.config

  server.registerTool(
    'read',
    {
      description:
        'Fetch recent messages from a Zulip stream/topic. Uses the sender bot API key and marks fetched messages as read.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name (uses their bot for read tracking)'),
        stream: z.string().describe('Stream name'),
        topic: z.string().describe('Topic name'),
        count: z.number().optional().default(10).describe('Number of messages to fetch'),
      }),
    },
    async ({ sender, stream, topic, count }) => {
      const botClientResult = await clientForTeammate(db, zulipSite, sender)
      if (botClientResult.isErr()) {
        return errorResult(formatError(botClientResult.error))
      }

      const botClient = botClientResult.value

      // Fetch one extra to detect if there are more messages beyond the requested count.
      // Don't mark as read yet — we only want to mark the displayed messages.
      const fetchResult = await fetchMessages(
        botClient,
        {
          anchor: 'newest',
          numBefore: count + 1,
          numAfter: 0,
          narrow: [
            { operator: 'stream', operand: stream },
            { operator: 'topic', operand: topic },
          ],
          applyMarkdown: false,
        },
        { markRead: false },
      )

      if (fetchResult.isErr()) {
        return errorResult(formatError(fetchResult.error))
      }

      const messages = fetchResult.value
      if (messages.length === 0) {
        return textResult(`(no messages in ${stream}/${topic})`)
      }

      const hasMore = messages.length > count
      // Zulip returns messages sorted by ID (oldest first), so slice from the end
      const displayed = hasMore ? messages.slice(-count) : messages

      const header = hasMore
        ? `(showing ${count} most recent — pass a larger count to see more history)\n\n`
        : `(showing all ${displayed.length} message${displayed.length === 1 ? '' : 's'})\n\n`

      // Mark only the displayed messages as read; don't fail if this errors
      const markResult = await markAsRead(
        botClient,
        displayed.map((m) => m.id),
      )
      const warning = markResult.isErr() ? '(warning: failed to mark messages as read)\n' : ''

      return textResult(`${warning}${header}${formatMessages(displayed, false)}`)
    },
  )
}
