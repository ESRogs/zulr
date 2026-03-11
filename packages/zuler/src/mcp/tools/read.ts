import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { markAsRead } from 'zulip-ts'
import { getTeammate } from '../../state/teammates.ts'
import {
  consumeUnreadDmMessages,
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
        'Fetch recent messages from a Zulip stream/topic or DM conversation. For stream messages, provide "stream" and "topic". For DMs, provide "user" (ID, name, or email). Uses the sender bot API key and marks fetched messages as read.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name (uses their bot for read tracking)'),
        stream: z.string().optional().describe('Stream name (for stream messages)'),
        topic: z.string().optional().describe('Topic name (for stream messages)'),
        user: z
          .union([z.number(), z.string()])
          .optional()
          .describe('User ID, full name, or email (for DM conversations)'),
        count: z.coerce.number().optional().default(10).describe('Number of messages to fetch'),
      }),
    },
    async ({ sender, stream, topic, user, count }) => {
      const teammateResult = await getTeammate(ctx.config.db, sender)
      if (teammateResult.isErr()) return errorResult(formatError(teammateResult.error))
      const botUserId = teammateResult.value.botUserId ?? undefined

      if (user !== undefined) {
        const resolveResult = await ctx.resolveUser(user)
        if (resolveResult.isErr()) {
          return errorResult(resolveResult.error)
        }
        return readDms(ctx, sender, resolveResult.value.user_id, count, botUserId)
      }
      if (stream && topic) {
        return readStream(ctx, sender, stream, topic, count, botUserId)
      }
      return errorResult('provide either "stream" and "topic" (for streams) or "user" (for DMs)')
    },
  )
}

async function readStream(
  ctx: ToolContext,
  sender: string,
  stream: string,
  topic: string,
  count: number,
  botUserId?: number,
) {
  const botClientResult = await ctx.getTeammateClient(sender)
  if (botClientResult.isErr()) {
    return errorResult(botClientResult.error)
  }

  const botClient = botClientResult.value

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
    { markRead: false, botUserId },
  )

  if (fetchResult.isErr()) {
    return errorResult(formatError(fetchResult.error))
  }

  const inboxMessages = consumeUnreadInboxMessages(ctx.config.teamName, sender, stream, topic)
  const inboxFormatted = inboxToFormattedMessages(inboxMessages)

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

  const displayedZulipIds = displayed.filter((m) => m.id > 0).map((m) => m.id)
  if (displayedZulipIds.length > 0) {
    const markResult = await markAsRead(botClient, displayedZulipIds)
    if (markResult.isErr()) {
      return textResult(`(warning: failed to mark messages as read)\n${body}`)
    }
  }

  return textResult(body)
}

async function readDms(
  ctx: ToolContext,
  sender: string,
  userId: number,
  count: number,
  botUserId?: number,
) {
  const botClientResult = await ctx.getTeammateClient(sender)
  if (botClientResult.isErr()) {
    return errorResult(botClientResult.error)
  }

  const botClient = botClientResult.value

  const fetchResult = await fetchMessages(
    botClient,
    {
      anchor: 'newest',
      numBefore: count + 1,
      numAfter: 0,
      narrow: [{ operator: 'pm-with', operand: [userId] }],
      applyMarkdown: false,
    },
    { markRead: false, botUserId },
  )

  if (fetchResult.isErr()) {
    return errorResult(formatError(fetchResult.error))
  }

  // Consume unread DM inbox messages from this user
  consumeUnreadDmMessages(ctx.config.teamName, sender, userId)

  const allMessages = [...fetchResult.value]

  if (allMessages.length === 0) {
    return textResult('(no DMs with this user)')
  }

  const hasMore = allMessages.length > count
  const sorted = allMessages.toSorted((a, b) => a.timestamp - b.timestamp)
  const displayed = sorted.slice(-count)

  const header = hasMore
    ? `(showing ${displayed.length} most recent — pass a larger count to see more history)\n\n`
    : `(showing all ${displayed.length} message${displayed.length === 1 ? '' : 's'})\n\n`

  const body = `${header}${formatMessages(displayed, false)}`

  const displayedZulipIds = displayed.filter((m) => m.id > 0).map((m) => m.id)
  if (displayedZulipIds.length > 0) {
    const markResult = await markAsRead(botClient, displayedZulipIds)
    if (markResult.isErr()) {
      return textResult(`(warning: failed to mark messages as read)\n${body}`)
    }
  }

  return textResult(body)
}
