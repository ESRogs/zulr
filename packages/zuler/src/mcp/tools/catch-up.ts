import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { markAsRead } from 'zulip-ts'
import { getTeammate } from '../../state/teammates.ts'
import { fetchMessages, formatMessages } from '../../zulip/message-reader.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerCatchUpTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'catch-up',
    {
      description:
        'Fetch recent messages from all subscribed streams/topics. By default fetches all recent messages (useful after context compaction). With unreadOnly: true, fetches only unread messages and marks them as read (useful after a restart).',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        maxMessages: z
          .number()
          .optional()
          .default(50)
          .describe('Maximum total messages to return (default: 50)'),
        maxHours: z
          .number()
          .optional()
          .default(24)
          .describe('Maximum lookback time in hours (default: 24)'),
        unreadOnly: z
          .boolean()
          .optional()
          .default(false)
          .describe('If true, fetch only unread messages and mark them as read'),
      }),
    },
    async ({ sender, maxMessages, maxHours, unreadOnly }) => {
      const teammateResult = await getTeammate(ctx.config.db, sender)
      if (teammateResult.isErr()) {
        return errorResult(formatError(teammateResult.error))
      }

      const teammate = teammateResult.value

      const botClientResult = await ctx.getTeammateClient(sender)
      if (botClientResult.isErr()) {
        return errorResult(botClientResult.error)
      }
      const botClient = botClientResult.value

      const subs: { stream: string; topic?: string }[] = [
        ...teammate.streamSubs.map((stream) => ({ stream })),
        ...teammate.topicSubs.map(({ stream, topic }) => ({ stream, topic })),
      ]

      if (subs.length === 0) {
        return errorResult('no subscriptions — subscribe to streams before catching up')
      }

      const cutoff = Date.now() / 1000 - maxHours * 3600
      const perSubLimit = Math.max(10, Math.ceil(maxMessages / subs.length))

      const fetchConfig = unreadOnly
        ? { anchor: 'first_unread' as const, numBefore: 0, numAfter: perSubLimit }
        : { anchor: 'newest' as const, numBefore: perSubLimit, numAfter: 0 }

      // Fetch from all subscriptions in parallel (without marking read)
      const fetchResults = await Promise.all(
        subs.map((sub) => {
          const narrow = [
            { operator: 'stream' as const, operand: sub.stream },
            ...(sub.topic ? [{ operator: 'topic' as const, operand: sub.topic }] : []),
          ]
          return fetchMessages(
            botClient,
            { ...fetchConfig, narrow, applyMarkdown: false },
            { markRead: false, streamFallback: sub.stream, topicFallback: sub.topic },
          )
        }),
      )

      const failedCount = fetchResults.filter((r) => r.isErr()).length

      // Collect messages, sorted chronologically. Time filter only applies in
      // default mode — unreadOnly mode shows all unreads regardless of age.
      const allMessages = fetchResults
        .flatMap((r) => (r.isOk() ? [...r.value] : []))
        .filter((msg) => unreadOnly || msg.timestamp >= cutoff)
        .toSorted((a, b) => a.timestamp - b.timestamp)

      const trimmed = allMessages.slice(-maxMessages)

      if (trimmed.length === 0) {
        return textResult(
          unreadOnly
            ? '(no unread messages across your subscriptions)'
            : `(no recent messages in the last ${maxHours} hours across your subscriptions)`,
        )
      }

      // In unreadOnly mode, mark the returned messages as read
      let markWarning = ''
      if (unreadOnly) {
        const markResult = await markAsRead(
          botClient,
          trimmed.map((m) => m.id),
        )
        if (markResult.isErr()) {
          markWarning = `(warning: failed to mark messages as read: ${formatError(markResult.error)})\n`
        }
      }

      const skippedCount = allMessages.length - trimmed.length
      const infos = [
        allMessages.length > maxMessages
          ? `Showing ${trimmed.length} of ${allMessages.length} messages (most recent).`
          : `Showing all ${trimmed.length} message${trimmed.length === 1 ? '' : 's'}.`,
        ...(unreadOnly && skippedCount > 0
          ? [
              `${skippedCount} older unread message${skippedCount === 1 ? '' : 's'} not shown — call again to see them.`,
            ]
          : []),
        ...(failedCount > 0 ? [`Warning: ${failedCount} subscription(s) failed to fetch.`] : []),
      ]
      const header = `${markWarning}${infos.join(' ')}\n\n`

      return textResult(`${header}${formatMessages(trimmed, true)}`)
    },
  )
}
