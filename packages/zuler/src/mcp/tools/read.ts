import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { markAsRead } from 'zulip-ts'
import {
  consumeUnreadInboxMessages,
  inboxToFormattedMessages,
  mergeWithInbox,
} from '../../zulip/inbox.ts'
import { fetchMessages, formatMessages } from '../../zulip/message-reader.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerReadTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'read',
    {
      description:
        'Fetch recent messages from a Zulip stream/topic. Uses the sender bot API key and marks fetched messages as read. Also consumes any unread messages from the inbox for this topic.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name (uses their bot for read tracking)'),
        stream: z.string().describe('Stream name'),
        topic: z.string().describe('Topic name'),
        count: z.number().optional().default(10).describe('Number of messages to fetch'),
      }),
    },
    async ({ sender, stream, topic, count }) => {
      const botClientResult = await ctx.getTeammateClient(sender)
      if (botClientResult.isErr()) {
        return errorResult(botClientResult.error)
      }

      const botClient = botClientResult.value

      // Fetch from Zulip first — consume inbox only after a successful fetch
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

      // Consume unread inbox messages for this topic (marks them as read in the inbox file)
      const inboxMessages = consumeUnreadInboxMessages(ctx.config.teamName, sender, stream, topic)
      const inboxFormatted = inboxToFormattedMessages(inboxMessages)

      // Merge Zulip results with inbox-only messages
      const zulipMessages = fetchResult.value
      const allMessages = mergeWithInbox(zulipMessages, inboxFormatted)

      if (allMessages.length === 0) {
        return textResult(`(no messages in ${stream}/${topic})`)
      }

      const hasMore = allMessages.length > count
      const sorted = allMessages.toSorted((a, b) => a.timestamp - b.timestamp)
      const displayed = sorted.slice(-count)

      const header = hasMore
        ? `(showing ${displayed.length} most recent — pass a larger count to see more history)\n\n`
        : `(showing all ${displayed.length} message${displayed.length === 1 ? '' : 's'})\n\n`

      const body = `${header}${formatMessages(displayed, false)}`

      // Mark only displayed Zulip messages as read; don't fail if this errors
      const displayedZulipIds = displayed.filter((m) => m.id > 0).map((m) => m.id)
      if (displayedZulipIds.length > 0) {
        const markResult = await markAsRead(botClient, displayedZulipIds)
        if (markResult.isErr()) {
          return textResult(`(warning: failed to mark messages as read)\n${body}`)
        }
      }

      return textResult(body)
    },
  )
}
