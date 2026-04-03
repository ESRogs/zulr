import { z } from 'zod'
import { getSubscriptions, markAsRead } from 'zulip-ts'
import {
  consumeAllUnreadDmMessages,
  consumeAllUnreadStreamMessages,
  inboxToFormattedMessages,
  mergeWithInbox,
} from '../../zulip/inbox.ts'
import { fetchMessages, formatMessages } from '../../zulip/message-reader.ts'
import {
  buildUserIdResolver,
  errorResult,
  formatError,
  type ToolContext,
  type ToolRegistrar,
  textResult,
  zBool,
  zTeammateName,
} from '../helpers.ts'

export function registerCatchUpTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'catch-up',
    {
      description:
        "Fetch recent messages from all subscribed streams/topics and DMs. By default fetches all recent messages (useful after context compaction). With unreadOnly: true, fetches only unread messages and marks them as read (useful after a restart). Consider reacting to important messages after catching up to signal you've read them.",
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        maxMessages: z.coerce
          .number()
          .optional()
          .default(50)
          .describe('Maximum total messages to return (default: 50)'),
        maxHours: z.coerce
          .number()
          .optional()
          .default(24)
          .describe('Maximum lookback time in hours (default: 24)'),
        unreadOnly: zBool
          .optional()
          .default(false)
          .describe('If true, fetch only unread messages and mark them as read'),
      }),
    },
    async ({ sender, maxMessages, maxHours, unreadOnly }) => {
      const botClientResult = await ctx.getTeammateClient(sender)
      if (botClientResult.isErr()) {
        return errorResult(botClientResult.error)
      }
      const { client: botClient, botUserId } = botClientResult.value

      // Get the bot's channel subscriptions from Zulip

      const subsResult = await getSubscriptions(botClient)
      if (subsResult.isErr()) {
        return errorResult(formatError(subsResult.error))
      }
      const channels = subsResult.value.subscriptions.map((s) => s.name)

      const cutoff = Date.now() / 1000 - maxHours * 3600

      // eslint-disable-next-line neverthrow/must-use-result
      const resolveUserId = (await buildUserIdResolver(ctx)).unwrapOr(() => undefined)

      const fetchConfig = unreadOnly
        ? { anchor: 'first_unread' as const, numBefore: 0, numAfter: maxMessages }
        : { anchor: 'newest' as const, numBefore: maxMessages, numAfter: 0 }

      // Fetch from all subscribed channels + DMs in parallel (without marking read)
      const fetchResults = await Promise.all([
        ...channels.map((channel) => {
          const narrow = [{ operator: 'stream' as const, operand: channel }]
          return fetchMessages(
            botClient,
            { ...fetchConfig, narrow, applyMarkdown: false },
            { markRead: false, streamFallback: channel, resolveUserId },
          )
        }),
        // eslint-disable-next-line neverthrow/must-use-result
        fetchMessages(
          botClient,
          { ...fetchConfig, narrow: [{ operator: 'is', operand: 'dm' }], applyMarkdown: false },
          { markRead: false, botUserId, resolveUserId },
        ),
      ])

      const failedCount = fetchResults.filter((r) => r.isErr()).length

      // Consume inbox after fetch attempts complete (stream messages + DMs)
      const streamInbox = consumeAllUnreadStreamMessages(ctx.config.teamName, sender)
      const dmInbox = consumeAllUnreadDmMessages(ctx.config.teamName, sender)
      const inboxFormatted = inboxToFormattedMessages([...streamInbox, ...dmInbox])

      // Merge Zulip results with inbox-only messages, deduplicate by ID
      const zulipMessages = fetchResults.flatMap((r) => (r.isOk() ? [...r.value] : []))
      const allFetched = mergeWithInbox(zulipMessages, inboxFormatted)

      // Filter out group DMs (not supported yet)
      const groupDmCount = allFetched.filter((m) => m.type === 'dm' && m.isGroupDm).length
      const merged = allFetched.filter((m) => !(m.type === 'dm' && m.isGroupDm))

      // Apply time filter and count how many were excluded
      const timeFiltered = merged.filter((msg) => msg.timestamp >= cutoff)
      const olderCount = merged.length - timeFiltered.length
      const allMessages = timeFiltered.toSorted((a, b) => a.timestamp - b.timestamp)

      const trimmed = allMessages.slice(-maxMessages)

      if (trimmed.length === 0) {
        return textResult(
          unreadOnly
            ? `(no unread messages in the last ${maxHours} hours across your subscriptions)`
            : `(no messages in the last ${maxHours} hours across your subscriptions)`,
        )
      }

      // Only use real Zulip IDs (positive) for API calls
      const trimmedZulipIds = trimmed.filter((m) => m.id > 0).map((m) => m.id)

      // Mark as read on Zulip (unreadOnly mode only — default mode doesn't change Zulip state)
      let markWarning = ''
      if (unreadOnly && trimmedZulipIds.length > 0) {
        const markResult = await markAsRead(botClient, trimmedZulipIds)
        if (markResult.isErr()) {
          markWarning = `(warning: failed to mark messages as read: ${formatError(markResult.error)})\n`
        }
      }

      const additionalInWindow = allMessages.length - trimmed.length
      const infos = [
        additionalInWindow > 0
          ? `Showing the ${trimmed.length} most recent messages. There are ${additionalInWindow} more within the last ${maxHours}h — increase maxMessages to see more.`
          : `Showing all ${trimmed.length} message${trimmed.length === 1 ? '' : 's'} from the last ${maxHours}h.`,
        ...(olderCount > 0
          ? [
              `${olderCount} older message${olderCount === 1 ? '' : 's'} outside ${maxHours}h window — increase maxHours to see them.`,
            ]
          : []),
        ...(groupDmCount > 0
          ? [
              `${groupDmCount} group DM${groupDmCount === 1 ? '' : 's'} skipped (not supported yet).`,
            ]
          : []),
        ...(failedCount > 0 ? [`Warning: ${failedCount} subscription(s) failed to fetch.`] : []),
      ]
      const header = `${markWarning}${infos.join(' ')}\n\n`

      return textResult(`${header}${formatMessages(trimmed, true)}`)
    },
  )
}
