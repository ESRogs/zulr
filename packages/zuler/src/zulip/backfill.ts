import type { Kysely } from 'kysely'
import type { FollowedTopic, ZulipSession } from 'zulip-client-ts'
import type { MessageId, NarrowFilter, ZulipClient } from 'zulip-ts'
import { getMessages, markAsRead } from 'zulip-ts'
import { clientForTeammate } from '../bot-manager.ts'
import type { ZulerDatabase } from '../state/db.ts'
import { listTeammates } from '../state/teammates.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { readInbox, writeToInbox } from './inbox.ts'
import { formatMessageFooter } from './message-reader.ts'
import { sanitizeSummary, truncate } from './routing.ts'

type BackfillOptions = {
  readonly db: Kysely<ZulerDatabase>
  readonly teamName: TeamName
  readonly site: string
  /** Maximum unread messages to write per bot. */
  readonly maxPerBot?: number
  /** Get a bot's session (for followed topics). */
  readonly getSession: (name: TeammateName) => ZulipSession | undefined
  readonly onLog?: (msg: string) => void
  readonly onError?: (error: unknown) => void
}

const DEFAULT_MAX_PER_BOT = 20

/**
 * Wait for a session to have a registeredAt timestamp (meaning /register completed).
 * Polls every 200ms up to a timeout.
 */
async function waitForSession(session: ZulipSession, timeoutMs: number = 10_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (session.getRegisteredAt() !== undefined) return true
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

/** Build narrow filters for a bot's followed topics, mentions, and DMs. */
function buildNarrows(
  followedTopics: readonly FollowedTopic[],
): readonly (readonly NarrowFilter[])[] {
  const unreadFilter: NarrowFilter = { operator: 'is', operand: 'unread' }

  const topicNarrows = followedTopics.map(
    (ft) =>
      [
        { operator: 'stream' as const, operand: ft.streamId },
        { operator: 'topic' as const, operand: ft.topic },
        unreadFilter,
      ] as const,
  )

  const mentionNarrow = [{ operator: 'is' as const, operand: 'mentioned' }, unreadFilter] as const

  const dmNarrow = [{ operator: 'is' as const, operand: 'dm' }, unreadFilter] as const

  return [...topicNarrows, mentionNarrow, dmNarrow]
}

/** Backfill a single bot's inbox with missed unread messages. */
async function backfillBot(
  botName: TeammateName,
  client: ZulipClient,
  session: ZulipSession,
  options: BackfillOptions,
): Promise<number> {
  const { teamName, maxPerBot = DEFAULT_MAX_PER_BOT, onError } = options

  const followedTopics = session.getFollowedTopics()
  const narrows = buildNarrows(followedTopics)

  // Fetch from all narrows in parallel
  const fetchResults = await Promise.all(
    narrows.map((narrow) =>
      getMessages(client, {
        anchor: 'newest',
        numBefore: maxPerBot,
        numAfter: 0,
        narrow: [...narrow],
        applyMarkdown: false,
      }),
    ),
  )

  // Collect all fetched messages, deduplicate by message ID
  const seenIds = new Set<MessageId>()
  const allMessages = fetchResults.flatMap((result) => {
    if (result.isErr()) {
      onError?.(result.error)
      return []
    }
    return result.value.messages.filter((msg) => {
      if (seenIds.has(msg.id)) return false
      seenIds.add(msg.id)
      return true
    })
  })

  if (allMessages.length === 0) return 0

  // Sort newest first, take the cap
  const sorted = allMessages.toSorted((a, b) => b.timestamp - a.timestamp)
  const capped = sorted.slice(0, maxPerBot)

  // Deduplicate against existing inbox
  const inbox = readInbox(teamName, botName)
  const inboxIds = new Set(
    inbox.flatMap((m) => (m.zulipMessageId !== undefined ? [m.zulipMessageId] : [])),
  )
  const missing = capped.filter((msg) => !inboxIds.has(msg.id))

  if (missing.length === 0) return 0

  // Filter out messages sent by the bot itself
  const ownUserId = session.getOwnUserId()
  const toWrite = ownUserId ? missing.filter((msg) => msg.sender_id !== ownUserId) : missing

  if (toWrite.length === 0) return 0

  // Write to inbox (oldest first so inbox order is chronological)
  const chronological = toWrite.toSorted((a, b) => a.timestamp - b.timestamp)
  for (const msg of chronological) {
    const isStream = msg.type === 'stream'
    const senderName = msg.sender_full_name
    const content = msg.content

    const from = isStream
      ? `zulip:${msg.display_recipient}/${msg.subject}:${senderName}`
      : `zulip:${senderName}`

    const summary = sanitizeSummary(truncate(content, 60))

    writeToInbox(teamName, botName, {
      from,
      text: `${content}\n${formatMessageFooter(msg.id, msg.timestamp)}`,
      summary,
      zulipMessageId: msg.id,
      zulipSenderId: msg.sender_id,
      ...(isStream ? { zulipStream: msg.display_recipient, zulipTopic: msg.subject } : {}),
      zulipSender: senderName,
    })
  }

  // Mark as read on Zulip
  const idsToMark = chronological.map((m) => m.id)
  // eslint-disable-next-line neverthrow/must-use-result
  const markResult = await markAsRead(client, idsToMark)
  if (markResult.isErr()) {
    onError?.(`backfill mark-as-read failed for ${botName}: ${JSON.stringify(markResult.error)}`)
  }

  // If we hit the cap and there were more messages, write overflow summary
  if (sorted.length > maxPerBot) {
    const overflow = sorted.length - maxPerBot
    writeToInbox(teamName, botName, {
      from: 'zuler:system',
      text: `${overflow} additional unread message(s) were not loaded during startup backfill. Run catch-up to see them.`,
      summary: `${overflow} more unread message(s) — run catch-up`,
    })
  }

  return chronological.length
}

/**
 * Backfill all bots' inboxes with unread messages missed while the server was down.
 * Waits for each bot's session to initialize, then fetches from followed topics,
 * mentions, and DMs.
 */
export async function backfillAllInboxes(options: BackfillOptions): Promise<void> {
  const { db, site, getSession, onLog, onError } = options

  // eslint-disable-next-line neverthrow/must-use-result
  const teammatesResult = await listTeammates(db)
  if (teammatesResult.isErr()) {
    onError?.(teammatesResult.error)
    return
  }

  const results = await Promise.all(
    teammatesResult.value.map(async (teammate) => {
      const session = getSession(teammate.name)
      if (!session) {
        onError?.(`no session for ${teammate.name}, skipping backfill`)
        return { name: teammate.name, count: 0 }
      }

      const ready = await waitForSession(session)
      if (!ready) {
        onError?.(`session for ${teammate.name} did not initialize in time, skipping backfill`)
        return { name: teammate.name, count: 0 }
      }

      // eslint-disable-next-line neverthrow/must-use-result
      const clientResult = await clientForTeammate(db, site, teammate.name)
      if (clientResult.isErr()) {
        onError?.(
          `failed to get client for ${teammate.name}: ${JSON.stringify(clientResult.error)}`,
        )
        return { name: teammate.name, count: 0 }
      }

      const count = await backfillBot(teammate.name, clientResult.value.client, session, options)
      return { name: teammate.name, count }
    }),
  )

  const total = results.reduce((sum, r) => sum + r.count, 0)
  const details = results
    .filter((r) => r.count > 0)
    .map((r) => `${r.name}: ${r.count}`)
    .join(', ')

  if (total > 0) {
    onLog?.(`backfilled ${total} messages (${details})`)
  } else {
    onLog?.('backfill: no missed messages')
  }
}
