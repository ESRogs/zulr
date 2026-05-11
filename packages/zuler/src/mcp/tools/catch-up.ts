import { z } from 'zod'
import type { Message, MessageId } from 'zulip-ts'
import { getMessages, markAsRead } from 'zulip-ts'
import { buildFollowedNarrows } from '../../zulip/followed-narrows.ts'
import {
  consumeAllUnreadDmMessages,
  consumeAllUnreadStreamMessages,
  inboxToFormattedMessages,
  mergeWithInbox,
} from '../../zulip/inbox.ts'
import {
  type FormattedMessage,
  formatMessages,
  toFormattedMessage,
} from '../../zulip/message-reader.ts'
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

/**
 * Compute the per-narrow message limit so that the total fetched across all narrows is
 * bounded. We sort + trim to `maxMessages` at the end, so each narrow only needs a slice
 * of the total budget. The total fetch budget is `maxMessages × 4` — generous enough that
 * a few busy narrows can fill the final window, but bounded so a bot following 100+ topics
 * doesn't trigger a flood of API calls. The minimum per narrow is 1 so every narrow gets
 * at least its most recent message.
 */
export function computePerNarrowLimit(maxMessages: number, narrowCount: number): number {
  if (narrowCount === 0) return 0
  const totalBudget = maxMessages * 4
  return Math.max(1, Math.ceil(totalBudget / narrowCount))
}

export type FilterPipelineInput = {
  readonly messages: readonly FormattedMessage[]
  /** Unix-epoch-seconds cutoff: messages with `timestamp < cutoff` are excluded from the in-window result. */
  readonly cutoff: number
  /** Maximum messages to return after sorting and trimming. */
  readonly maxMessages: number
}

export type FilterPipelineOutput = {
  /** Messages within the time window, sorted oldest → newest, trimmed to maxMessages. */
  readonly trimmed: readonly FormattedMessage[]
  /** Count of group DMs filtered out (not supported yet). */
  readonly groupDmCount: number
  /** Count of messages older than the cutoff (excluded from `trimmed`). */
  readonly olderCount: number
  /** Count of messages within the window but trimmed off (older end of the window). */
  readonly additionalInWindow: number
  /** Subset of `trimmed` IDs that correspond to real Zulip messages (positive IDs). */
  readonly trimmedZulipIds: readonly MessageId[]
}

/**
 * Apply the catch-up message pipeline: filter group DMs, apply the time window, sort
 * oldest-first, trim to maxMessages, and extract real Zulip IDs (positive IDs only —
 * inbox-only messages use negative IDs as placeholders).
 *
 * Pure function for testability. Caller handles fetching, inbox merging, and mark-as-read.
 */
export function applyCatchUpFilters(input: FilterPipelineInput): FilterPipelineOutput {
  const { messages, cutoff, maxMessages } = input

  const groupDmCount = messages.filter((m) => m.type === 'dm' && m.isGroupDm).length
  const withoutGroupDms = messages.filter((m) => !(m.type === 'dm' && m.isGroupDm))
  const inWindow = withoutGroupDms.filter((m) => m.timestamp >= cutoff)
  const olderCount = withoutGroupDms.length - inWindow.length

  const sorted = inWindow.toSorted((a, b) => a.timestamp - b.timestamp)
  const trimmed = sorted.slice(-maxMessages)
  const additionalInWindow = sorted.length - trimmed.length

  const trimmedZulipIds = trimmed.filter((m) => m.id > 0).map((m) => m.id)

  return { trimmed, groupDmCount, olderCount, additionalInWindow, trimmedZulipIds }
}

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

      const { narrows } = buildFollowedNarrows(session, { unreadOnly })

      const perNarrowLimit = computePerNarrowLimit(maxMessages, narrows.length)

      // Fetch narrows sequentially to avoid hitting Zulip's rate limit
      const seenIds = new Set<MessageId>()
      const rawMessages: Message[] = []
      let failedCount = 0
      for (const narrow of narrows) {
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

      const { trimmed, groupDmCount, olderCount, additionalInWindow, trimmedZulipIds } =
        applyCatchUpFilters({ messages: allFetched, cutoff, maxMessages })

      if (trimmed.length === 0) {
        return textResult(
          unreadOnly
            ? `(no unread messages in the last ${maxHours} hours across your followed topics, mentions, and DMs)`
            : `(no messages in the last ${maxHours} hours across your followed topics, mentions, and DMs)`,
        )
      }

      // Mark as read on Zulip (unreadOnly mode only — default mode doesn't change Zulip state)
      let markWarning = ''
      if (unreadOnly && trimmedZulipIds.length > 0) {
        const markResult = await markAsRead(botClient, [...trimmedZulipIds])
        if (markResult.isErr()) {
          markWarning = `(warning: failed to mark messages as read: ${getErrorMessage(markResult.error)})\n`
        }
      }
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
