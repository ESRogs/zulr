import { z } from 'zod'
import type { Message, MessageId } from 'zulip-ts'
import { getMessages, markAsRead } from 'zulip-ts'
import { buildFollowedNarrowGroups } from '../../zulip/followed-narrows.ts'
import {
  consumeAllUnreadDmMessages,
  consumeAllUnreadStreamMessages,
  inboxToFormattedMessages,
  mergeWithInbox,
} from '../../zulip/inbox.ts'
import { formatMessages, toFormattedMessage } from '../../zulip/message-reader.ts'
import {
  buildUserIdResolver,
  errorResult,
  getErrorMessage,
  resolveSender,
  type ToolContext,
  type ToolRegistrar,
  textResult,
  zBool,
  zOptionalTeammateName,
} from '../helpers.ts'

export function registerCatchUpTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'catch-up',
    {
      description:
        "Fetch recent messages from all followed topics, mentions, and DMs. By default fetches all recent messages (useful after context compaction). With unreadOnly: true, fetches only unread messages and marks them as read (useful after a restart). Consider reacting to important messages after catching up to signal you've read them.",
      inputSchema: z.object({
        sender: zOptionalTeammateName.describe('Teammate name'),
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
      const senderResult = resolveSender(ctx, sender)
      if (senderResult.isErr()) return errorResult(senderResult.error)

      const botClientResult = await ctx.credentials.getTeammateClient(senderResult.value)
      if (botClientResult.isErr()) return errorResult(botClientResult.error)
      const { client: botClient, botUserId } = botClientResult.value

      const session = ctx.getEventListenerManager()?.getSession(senderResult.value)
      if (!session) {
        return errorResult(
          `No active session for "${senderResult.value}". The bot may not be registered or the event listener may not be running.`,
        )
      }

      const cutoff = Date.now() / 1000 - maxHours * 3600

      // eslint-disable-next-line neverthrow/must-use-result
      const resolveUserId = (await buildUserIdResolver(ctx)).unwrapOr(() => undefined)

      // No channel-name resolver needed: catch-up only iterates narrows, not group labels.
      const { groups } = buildFollowedNarrowGroups(session, { unreadOnly })

      // Per-narrow fetch budget. We sort and trim to maxMessages at the end, so each
      // narrow only needs roughly its share of the total — plus oversampling for the
      // case where one narrow dominates (e.g. a busy topic), and a floor so quiet
      // narrows still get enough samples to be useful. The 2× oversample and floor of
      // 10 are heuristics; tune if catch-up latency becomes a concern with many
      // followed topics.
      const totalNarrows = groups.reduce((sum, g) => sum + g.narrows.length, 0)
      const perNarrowLimit = Math.max(10, Math.ceil((maxMessages * 2) / Math.max(totalNarrows, 1)))

      // Fetch narrows sequentially to avoid hitting Zulip's rate limit
      const seenIds = new Set<MessageId>()
      const rawMessages: Message[] = []
      let failedCount = 0
      for (const group of groups) {
        for (const narrow of group.narrows) {
          const result = await getMessages(botClient, {
            anchor: 'newest',
            numBefore: perNarrowLimit,
            numAfter: 0,
            narrow: [...narrow],
            applyMarkdown: false,
          })
          if (result.isErr()) {
            failedCount++
            continue
          }
          for (const msg of result.value.messages) {
            if (seenIds.has(msg.id)) continue
            seenIds.add(msg.id)
            rawMessages.push(msg)
          }
        }
      }

      const zulipFormatted = rawMessages.map((msg) =>
        toFormattedMessage(msg, { botUserId, resolveUserId }),
      )

      // Merge with locally-routed inbox messages and consume them (clears the posting gate)
      const streamInbox = consumeAllUnreadStreamMessages(
        ctx.config.teamName,
        senderResult.value,
      ).unwrapOr([])
      const dmInbox = consumeAllUnreadDmMessages(ctx.config.teamName, senderResult.value).unwrapOr(
        [],
      )
      const inboxFormatted = inboxToFormattedMessages([...streamInbox, ...dmInbox])
      const allFetched = mergeWithInbox(zulipFormatted, inboxFormatted)

      // Filter out group DMs (not supported yet) and apply the time window
      const groupDmCount = allFetched.filter((m) => m.type === 'dm' && m.isGroupDm).length
      const filtered = allFetched.filter((m) => !(m.type === 'dm' && m.isGroupDm))
      const inWindow = filtered.filter((msg) => msg.timestamp >= cutoff)
      const olderCount = filtered.length - inWindow.length

      const sorted = inWindow.toSorted((a, b) => a.timestamp - b.timestamp)
      const trimmed = sorted.slice(-maxMessages)

      if (trimmed.length === 0) {
        return textResult(
          unreadOnly
            ? `(no unread messages in the last ${maxHours} hours across your followed topics, mentions, and DMs)`
            : `(no messages in the last ${maxHours} hours across your followed topics, mentions, and DMs)`,
        )
      }

      // Mark as read on Zulip (unreadOnly mode only — default mode doesn't change Zulip state)
      const trimmedZulipIds = trimmed.filter((m) => m.id > 0).map((m) => m.id)
      let markWarning = ''
      if (unreadOnly && trimmedZulipIds.length > 0) {
        const markResult = await markAsRead(botClient, trimmedZulipIds)
        if (markResult.isErr()) {
          markWarning = `(warning: failed to mark messages as read: ${getErrorMessage(markResult.error)})\n`
        }
      }

      const additionalInWindow = sorted.length - trimmed.length
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
        ...(failedCount > 0 ? [`Warning: ${failedCount} narrow(s) failed to fetch.`] : []),
      ]
      const header = `${markWarning}${infos.join(' ')}\n\n`

      return textResult(`${header}${formatMessages(trimmed, true)}`)
    },
  )
}
