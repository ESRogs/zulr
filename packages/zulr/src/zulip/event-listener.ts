import type { Kysely } from 'kysely'
import type { ResultAsync } from 'neverthrow'
import { createSession, type ZulipSession } from 'zulip-client-ts'
import type {
  DisplayName,
  Email,
  EmojiName,
  MessageId,
  StreamId,
  TopicName,
  UserId,
  ZulipClient,
} from 'zulip-ts'
import { getMessage, isKnownEvent, markAsRead, TopicVisibility } from 'zulip-ts'
import { clientForTeammate } from '../bot-manager.ts'
import type { ZulrDatabase } from '../state/db.ts'
import { listTeammates, type StateError, type Teammate } from '../state/teammates.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { type BackfillBotOptions, backfillBot } from './backfill.ts'
import { writeToInbox } from './inbox.ts'
import { formatMessageFooter } from './message-reader.ts'
import { RESOLVED_PREFIX } from './resolved.ts'
import { routeDm, sanitizeSummary, truncate } from './routing.ts'

type EventListenerManagerOptions = {
  readonly db: Kysely<ZulrDatabase>
  readonly teamName: TeamName
  readonly site: string
  /** Pre-built bot client and email for standalone mode (bypasses DB lookup in startBot). */
  readonly standaloneBot?: {
    readonly client: ZulipClient
    readonly email: Email
  }
  /** Override the inbox file name (defaults to the bot's teammate name). Used in standalone mode where the agent is "team-lead" in its own team. */
  readonly inboxName?: TeammateName
  /** Called on each successfully routed message for logging/debugging. */
  readonly onRoute?: (info: {
    readonly stream?: string
    readonly topic?: string
    readonly sender: string
    readonly botName: string
    readonly summary: string
  }) => void
  /** Called on reaction events for logging. */
  readonly onReaction?: (info: {
    readonly emoji: string
    readonly op: 'add' | 'remove'
    readonly reactorName: string
    readonly messageId: MessageId
    readonly deliveredTo: readonly string[]
  }) => void
  /** Called on errors for logging. Listener continues after errors. */
  readonly onError?: (error: unknown) => void
  /** Called for informational lifecycle messages (session start, queue registration, retries). */
  readonly onLog?: (message: string) => void
  /** If set, listeners stop when this signal is aborted. */
  readonly signal?: AbortSignal
}

// 'reaction' is not processed by ZulipSession internally — it flows through
// to the onEvent callback where zulr handles it for inbox delivery.
const SESSION_EVENT_TYPES = [
  'message',
  'update_message',
  'delete_message',
  'update_message_flags',
  'user_topic',
  'realm_user',
  'reaction',
  'subscription',
] as const

const UNFOLLOW_DELAY_MS = 60_000

/** Key for the pending-unfollow timer map. */
function unfollowKey(streamId: StreamId, topic: TopicName): string {
  return `${streamId}:${topic.toLowerCase()}`
}

type HandleReactionParams = {
  readonly client: ZulipClient
  readonly session: ZulipSession
  readonly teamName: TeamName
  readonly botName: TeammateName
  readonly inboxName: TeammateName
  readonly botEmail: Email
  readonly messageId: MessageId
  readonly reactorUserId: UserId
  readonly emojiName: EmojiName
  readonly resolveUserName: (userId: UserId) => DisplayName | undefined
  readonly onReaction?: EventListenerManagerOptions['onReaction']
  readonly onError?: (error: unknown) => void
}

/**
 * Handle a reaction event for a specific bot: look up the reacted-to message
 * (cache first, then API fallback), and if this bot authored it, notify them.
 */
async function handleReaction(params: HandleReactionParams): Promise<void> {
  const {
    client,
    session,
    teamName,
    botName,
    inboxName,
    botEmail,
    messageId,
    reactorUserId,
    emojiName,
    resolveUserName,
    onReaction,
    onError,
  } = params

  // Check session cache first to avoid an API call
  let msg = session.getMessage(messageId)

  if (!msg) {
    const msgResult = await getMessage(client, messageId)

    if (msgResult.isErr()) {
      onError?.(msgResult.error)
      return
    }

    msg = msgResult.value.message
  }

  if (!msg) return

  const reactorName = resolveUserName(reactorUserId) ?? (`user ${reactorUserId}` as DisplayName)

  // Only notify the bot if they authored the message
  if (msg.sender_email !== botEmail) return

  const preview = sanitizeSummary(truncate(msg.content, 40))
  const from =
    msg.type === 'stream'
      ? `zulip:${msg.display_recipient}/${msg.subject}:${reactorName}`
      : `zulip:${reactorName}`

  const summary = `:${emojiName}: on \u201c${preview}\u201d`
  const text = `${summary}\n[msg:${messageId}]`

  writeToInbox(teamName, inboxName, {
    from,
    text,
    summary,
    zulipMessageId: messageId,
    zulipSenderId: reactorUserId,
    ...(msg.type === 'stream'
      ? { zulipStream: msg.display_recipient, zulipTopic: msg.subject }
      : {}),
    zulipSender: reactorName,
  }).match(
    () => {},
    (e) => onError?.(e),
  )
  onReaction?.({
    emoji: emojiName,
    op: 'add',
    reactorName,
    messageId,
    deliveredTo: [botName],
  })
}

/**
 * Start a ZulipSession for a single bot. The session handles event queue
 * lifecycle (register, long-poll, reconnect) and tracks unread/visibility/members
 * state. Only notification-worthy messages are delivered to the inbox.
 */
function startBotSession(
  botName: TeammateName,
  botClient: ZulipClient,
  botEmail: Email,
  allBotEmails: ReadonlySet<Email>,
  options: EventListenerManagerOptions,
  onSessionExit?: () => void,
): ZulipSession {
  const { db, teamName, onRoute, onReaction, onError, onLog, signal } = options
  const inboxTarget = options.inboxName ?? botName

  /** Pending auto-unfollow timers keyed by `streamId:normalizedTopic`. */
  const pendingUnfollows = new Map<string, ReturnType<typeof setTimeout>>()

  signal?.addEventListener('abort', () => {
    for (const timer of pendingUnfollows.values()) clearTimeout(timer)
    pendingUnfollows.clear()
  })

  const session = createSession({
    client: botClient,
    eventTypes: [...SESSION_EVENT_TYPES],
    allPublicStreams: true,
    signal,
    handler: {
      onNotification: (event, result) => {
        const msg = event.message

        // Skip messages sent by this bot
        if (msg.sender_email === botEmail) return

        if (msg.type === 'private') {
          // Block bot-to-bot DMs
          if (allBotEmails.has(msg.sender_email)) return

          routeDm(db, teamName, msg, inboxTarget).match(
            (dmResult) => {
              if (dmResult.delivered.length > 0) {
                onRoute?.({
                  sender: msg.sender_full_name,
                  botName,
                  summary: sanitizeSummary(truncate(msg.content, 60)),
                })
                // eslint-disable-next-line neverthrow/must-use-result
                markAsRead(botClient, [msg.id]).mapErr((markErr) => onError?.(markErr))
              }
            },
            (err) => onError?.(err),
          )
        } else {
          const stream = msg.display_recipient
          const topic = msg.subject
          const senderName = msg.sender_full_name
          const location = `${stream}/${topic}`
          const content = msg.content
          const from = `zulip:${location}:${senderName}`
          const summary = sanitizeSummary(truncate(content, 60))

          writeToInbox(teamName, inboxTarget, {
            from,
            text: `${content}\n${formatMessageFooter(msg.id, msg.timestamp)}`,
            summary,
            zulipMessageId: msg.id,
            zulipSenderId: msg.sender_id,
            zulipStream: stream,
            zulipTopic: topic,
            zulipSender: senderName,
          }).match(
            () => {},
            (e) => onError?.(e),
          )
          // Follow the topic when this bot is @-mentioned (skip resolved topics)
          if (
            (result.reason === 'mentioned' || result.reason === 'wildcard_mentioned') &&
            !topic.startsWith(RESOLVED_PREFIX)
          ) {
            // eslint-disable-next-line neverthrow/must-use-result
            session
              .setTopicVisibility(msg.stream_id, topic, TopicVisibility.FOLLOWED)
              .mapErr((err) => onError?.(err))
          }

          onRoute?.({ stream, topic, sender: senderName, botName, summary })
          // eslint-disable-next-line neverthrow/must-use-result
          markAsRead(botClient, [msg.id]).mapErr((markErr) => onError?.(markErr))
        }
      },

      onEvent: (event) => {
        if (!isKnownEvent(event)) return

        if (event.type === 'reaction' && event.op === 'add') {
          handleReaction({
            client: botClient,
            session,
            teamName,
            botName,
            inboxName: inboxTarget,
            botEmail,
            messageId: event.message_id,
            reactorUserId: event.user_id,
            emojiName: event.emoji_name,
            resolveUserName: (userId) => session.resolveUserId(userId),
            onReaction,
            onError,
          }).catch((err) => onError?.(err))
        }

        // Auto-unfollow resolved topics after a grace period
        if (event.type === 'update_message' && event.subject && event.stream_id) {
          const newTopic = event.subject
          const streamId = event.stream_id
          const key = unfollowKey(streamId, newTopic)

          // Check follow state using the original topic name — our local
          // TopicVisibilityState still has the pre-rename key because Zulip
          // doesn't emit a user_topic event on topic rename.
          const origTopic = event.orig_subject ?? newTopic
          const wasFollowed =
            session.isFollowed(streamId, origTopic) || session.isFollowed(streamId, newTopic)

          if (newTopic.startsWith(RESOLVED_PREFIX) && wasFollowed) {
            // Cancel any existing timer for this topic (e.g. re-resolve)
            const existing = pendingUnfollows.get(key)
            if (existing) clearTimeout(existing)

            const timer = setTimeout(() => {
              pendingUnfollows.delete(key)
              // eslint-disable-next-line neverthrow/must-use-result
              session
                .setTopicVisibility(streamId, newTopic, TopicVisibility.INHERIT)
                .map(() => onLog?.(`[${botName}] auto-unfollowed resolved topic: ${newTopic}`))
                .mapErr((err) => onError?.(err))
            }, UNFOLLOW_DELAY_MS)
            pendingUnfollows.set(key, timer)
          } else if (
            event.orig_subject?.startsWith(RESOLVED_PREFIX) &&
            !newTopic.startsWith(RESOLVED_PREFIX)
          ) {
            // Topic was un-resolved — cancel any pending unfollow
            const existing = pendingUnfollows.get(unfollowKey(streamId, event.orig_subject))
            if (existing) {
              clearTimeout(existing)
              pendingUnfollows.delete(unfollowKey(streamId, event.orig_subject))
              onLog?.(`[${botName}] cancelled auto-unfollow for un-resolved topic: ${newTopic}`)
            }
          }
        }
      },

      onReconnect: async () => {
        // Awaited before the event poll loop starts, so backfill completes
        // before new events are processed. Events accumulate server-side
        // during backfill and are delivered in order afterward.
        onLog?.(`[${botName}] session reconnected — running backfill`)
        const backfillOptions: BackfillBotOptions = {
          teamName,
          inboxName: inboxTarget,
          onLog,
          onError: (err) => onError?.(`[${botName}] reconnect backfill: ${err}`),
        }
        const result = await backfillBot(botName, botClient, session, backfillOptions)
        if (result.isErr()) {
          onError?.(`[${botName}] reconnect backfill failed: ${result.error}`)
        }
      },

      onError: (error) => {
        const prefix = `[${botName}]`
        if (typeof error === 'string') {
          onError?.(`${prefix} ${error}`)
        } else {
          onError?.(`${prefix} ${error.type}: ${error.message}`)
        }
      },

      onLog: (message) => {
        onLog?.(`[${botName}] ${message}`)
      },
    },
  })

  session.start().catch((err) => {
    onError?.(err)
    onSessionExit?.()
  })

  return session
}

/**
 * Manages per-bot event listeners. Start listeners for all registered bots,
 * and provides a method to start a listener for a newly registered bot.
 */
export type EventListenerManager = {
  /** Start a listener for a specific bot by name. No-op if already running. */
  readonly startBot: (name: TeammateName) => Promise<void>
  /** Start listeners for all registered bots. */
  readonly startAll: () => Promise<void>
  /** Get a bot's session for querying local state (unreads, visibility, etc.). */
  readonly getSession: (name: TeammateName) => ZulipSession | undefined
}

export function createEventListenerManager(
  options: EventListenerManagerOptions,
): EventListenerManager {
  const running = new Map<TeammateName, ZulipSession>()
  /** Cached set of all bot emails for bot-to-bot DM blocking. Refreshed on startAll/startBot. */
  let allBotEmails = new Set<Email>()

  function refreshBotEmails(): ResultAsync<readonly Teammate[], StateError> {
    return listTeammates(options.db).map((teammates) => {
      allBotEmails = new Set<Email>(teammates.map((t) => t.botEmail))
      return teammates
    })
  }

  async function startBot(name: TeammateName): Promise<void> {
    if (running.has(name)) return

    let botClient: ZulipClient
    let email: Email

    if (options.standaloneBot) {
      // Standalone mode: use pre-built client from env var credentials
      botClient = options.standaloneBot.client
      email = options.standaloneBot.email
      allBotEmails = new Set([email])
    } else {
      // Team mode: look up credentials from DB
      const clientResult = await clientForTeammate(options.db, options.site, name)
      if (clientResult.isErr()) {
        options.onError?.(
          `failed to get client for bot '${name}': ${JSON.stringify(clientResult.error)}`,
        )
        return
      }

      const teammatesResult = await refreshBotEmails()
      if (teammatesResult.isErr()) {
        options.onError?.(teammatesResult.error)
        return
      }

      const foundEmail = teammatesResult.value.find((t) => t.name === name)?.botEmail
      if (!foundEmail) {
        options.onError?.(`bot email not found for '${name}'`)
        return
      }

      botClient = clientResult.value.client
      email = foundEmail
    }

    const session = startBotSession(name, botClient, email, allBotEmails, options, () =>
      running.delete(name),
    )
    running.set(name, session)
  }

  async function startAll(): Promise<void> {
    const teammatesResult = await refreshBotEmails()
    if (teammatesResult.isErr()) {
      options.onError?.(teammatesResult.error)
      return
    }

    await Promise.all(teammatesResult.value.map((t) => startBot(t.name)))
  }

  return {
    startBot,
    startAll,
    getSession: (name: TeammateName) => running.get(name),
  }
}
