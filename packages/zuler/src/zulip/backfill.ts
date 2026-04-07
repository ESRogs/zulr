import type { Kysely } from 'kysely'
import { fromPromise, type Result, type ResultAsync } from 'neverthrow'
import type { FollowedTopic, ZulipSession } from 'zulip-client-ts'
import type {
  GetMessagesResponse,
  MessageId,
  NarrowFilter,
  StreamId,
  ZulipClient,
  ZulipError,
} from 'zulip-ts'
import { getMessages, getStreams, markAsRead } from 'zulip-ts'
import { clientForTeammate } from '../bot-manager.ts'
import type { ZulerDatabase } from '../state/db.ts'
import { listTeammates } from '../state/teammates.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { readInbox, writeToInbox } from './inbox.ts'
import { formatMessageFooter } from './message-reader.ts'
import { sanitizeSummary, truncate } from './routing.ts'

/** Options for backfilling a single bot's inbox. */
export type BackfillBotOptions = {
  readonly teamName: TeamName
  /** Maximum unread messages to write per bot. */
  readonly maxPerBot?: number
  /** Override the inbox file name (defaults to the bot name). Used in standalone mode. */
  readonly inboxName?: TeammateName
  readonly onLog?: (msg: string) => void
  readonly onError?: (error: unknown) => void
}

/** Options for backfilling all bots' inboxes at startup. */
export type BackfillOptions = BackfillBotOptions & {
  readonly db: Kysely<ZulerDatabase>
  readonly site: string
  /** In standalone mode, only backfill this single agent using the provided client. */
  readonly standaloneBot?: { readonly name: TeammateName; readonly client: ZulipClient }
  /** Get a bot's session (for followed topics). */
  readonly getSession: (name: TeammateName) => ZulipSession | undefined
  readonly onLog?: (msg: string) => void
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

/** A group of narrow filters to fetch, with a log label and the individual filters. */
type NarrowGroup = {
  readonly label: string
  readonly narrows: readonly (readonly NarrowFilter[])[]
}

/** Group followed topics by channel and add mentions + DMs. */
function buildNarrowGroups(
  followedTopics: readonly FollowedTopic[],
  resolveChannelName: (streamId: StreamId) => string | undefined,
): { readonly groups: readonly NarrowGroup[]; readonly channelCount: number } {
  const unreadFilter: NarrowFilter = { operator: 'is', operand: 'unread' }

  const byChannel = Map.groupBy(followedTopics, (ft) => ft.streamId)

  const channelGroups: NarrowGroup[] = [...byChannel.entries()].map(([streamId, topics]) => {
    const name = resolveChannelName(streamId) ?? `channel ${streamId}`
    return {
      label: `${topics.length} topic(s) in ${name}`,
      narrows: topics.map((ft) => [
        { operator: 'stream' as const, operand: ft.streamId },
        { operator: 'topic' as const, operand: ft.topic },
        unreadFilter,
      ]),
    }
  })

  return {
    groups: [
      ...channelGroups,
      { label: 'mentions', narrows: [[{ operator: 'is', operand: 'mentioned' }, unreadFilter]] },
      { label: 'DMs', narrows: [[{ operator: 'is', operand: 'dm' }, unreadFilter]] },
    ],
    channelCount: byChannel.size,
  }
}

/** Backfill a single bot's inbox with missed unread messages. */
export function backfillBot(
  botName: TeammateName,
  client: ZulipClient,
  session: ZulipSession,
  options: BackfillBotOptions,
): ResultAsync<number, unknown> {
  return fromPromise(backfillBotImpl(botName, client, session, options), (err) => err)
}

async function backfillBotImpl(
  botName: TeammateName,
  client: ZulipClient,
  session: ZulipSession,
  options: BackfillBotOptions,
): Promise<number> {
  const { teamName, maxPerBot = DEFAULT_MAX_PER_BOT, onLog, onError } = options
  const inboxTarget = options.inboxName ?? botName

  const followedTopics = session.getFollowedTopics()

  // Build a channel name resolver: subscriptions first, then full stream list as fallback
  const streamNameIndex = new Map<StreamId, string>()
  for (const sub of session.getAllSubscriptions()) {
    streamNameIndex.set(sub.stream_id, sub.name)
  }
  // Check if any followed topics are in unsubscribed channels
  const unresolved = followedTopics.filter((ft) => !streamNameIndex.has(ft.streamId))
  if (unresolved.length > 0) {
    const streamsResult = await getStreams(client)
    if (streamsResult.isOk()) {
      for (const stream of streamsResult.value.streams) {
        if (!streamNameIndex.has(stream.stream_id)) {
          streamNameIndex.set(stream.stream_id, stream.name)
        }
      }
    } else {
      onError?.(
        `getStreams failed for channel name resolution: ${JSON.stringify(streamsResult.error)}`,
      )
    }
  }

  const { groups, channelCount } = buildNarrowGroups(followedTopics, (streamId) =>
    streamNameIndex.get(streamId),
  )

  onLog?.(
    `[${botName}] backfilling ${followedTopics.length} topics across ${channelCount} channel(s) + mentions + DMs`,
  )

  // Fetch narrows sequentially to avoid hitting Zulip's rate limit
  const fetchResults: Result<GetMessagesResponse, ZulipError>[] = []
  for (const group of groups) {
    onLog?.(`[${botName}] fetching ${group.label}`)
    for (const narrow of group.narrows) {
      const result = await getMessages(client, {
        anchor: 'newest',
        numBefore: maxPerBot,
        numAfter: 0,
        narrow: [...narrow],
        applyMarkdown: false,
      })
      fetchResults.push(result)
    }
  }

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
  const inboxResult = readInbox(teamName, inboxTarget)
  if (inboxResult.isErr()) {
    onError?.(inboxResult.error)
    return 0
  }
  const inbox = inboxResult.value
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

    writeToInbox(teamName, inboxTarget, {
      from,
      text: `${content}\n${formatMessageFooter(msg.id, msg.timestamp)}`,
      summary,
      zulipMessageId: msg.id,
      zulipSenderId: msg.sender_id,
      ...(isStream ? { zulipStream: msg.display_recipient, zulipTopic: msg.subject } : {}),
      zulipSender: senderName,
    }).match(
      () => {},
      (e) => onError?.(e),
    )
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
    writeToInbox(teamName, inboxTarget, {
      from: 'zuler:system',
      text: `${overflow} additional unread message(s) were not loaded during startup backfill. Run catch-up to see them.`,
      summary: `${overflow} more unread message(s) — run catch-up`,
    }).match(
      () => {},
      (e) => onError?.(e),
    )
  }

  return chronological.length
}

/**
 * Backfill all bots' inboxes with unread messages missed while the server was down.
 * Waits for each bot's session to initialize, then fetches from followed topics,
 * mentions, and DMs.
 */
export async function backfillAllInboxes(options: BackfillOptions): Promise<void> {
  const { db, site, standaloneBot, getSession, onLog, onError } = options

  // In standalone mode, backfill only the single agent
  const botNames: TeammateName[] = []
  if (standaloneBot) {
    botNames.push(standaloneBot.name)
  } else {
    // eslint-disable-next-line neverthrow/must-use-result
    const teammatesResult = await listTeammates(db)
    if (teammatesResult.isErr()) {
      onError?.(teammatesResult.error)
      return
    }
    botNames.push(...teammatesResult.value.map((t) => t.name))
  }

  // Backfill bots sequentially to avoid hitting Zulip's rate limit
  const results: { name: TeammateName; count: number }[] = []
  for (const name of botNames) {
    const session = getSession(name)
    if (!session) {
      onError?.(`no session for ${name}, skipping backfill`)
      results.push({ name, count: 0 })
      continue
    }

    const ready = await waitForSession(session)
    if (!ready) {
      onError?.(`session for ${name} did not initialize in time, skipping backfill`)
      results.push({ name, count: 0 })
      continue
    }

    let client: ZulipClient
    if (standaloneBot) {
      client = standaloneBot.client
    } else {
      // eslint-disable-next-line neverthrow/must-use-result
      const clientResult = await clientForTeammate(db, site, name)
      if (clientResult.isErr()) {
        onError?.(`failed to get client for ${name}: ${JSON.stringify(clientResult.error)}`)
        results.push({ name, count: 0 })
        continue
      }
      client = clientResult.value.client
    }

    const botResult = await backfillBot(name, client, session, options)
    if (botResult.isErr()) {
      onError?.(`backfill failed for ${name}: ${botResult.error}`)
      results.push({ name, count: 0 })
      continue
    }
    results.push({ name, count: botResult.value })
  }

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
