import type { Kysely } from 'kysely'
import type { ResultAsync } from 'neverthrow'
import { createSession, type ZulipSession } from 'zulip-client-ts'
import type { DisplayName, Email, EmojiName, MessageId, UserId, ZulipClient } from 'zulip-ts'
import { getMessage, isKnownEvent, markAsRead, setUserTopic, TopicVisibility } from 'zulip-ts'
import { clientForTeammate } from '../bot-manager.ts'
import type { ZulerDatabase } from '../state/db.ts'
import { listTeammates, type StateError, type Teammate } from '../state/teammates.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { writeToInbox } from './inbox.ts'
import { formatMessageFooter } from './message-reader.ts'
import { routeDm, sanitizeSummary, truncate } from './routing.ts'

type EventListenerManagerOptions = {
  readonly db: Kysely<ZulerDatabase>
  readonly teamName: TeamName
  readonly site: string
  /** Called on each successfully routed message for logging/debugging. */
  readonly onRoute?: (info: {
    readonly stream?: string
    readonly topic?: string
    readonly sender: string
    readonly botName: string
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
  /** If set, listeners stop when this signal is aborted. */
  readonly signal?: AbortSignal
}

// 'reaction' is not processed by ZulipSession internally — it flows through
// to the onEvent callback where zuler handles it for inbox delivery.
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

/**
 * Handle a reaction event for a specific bot: look up the reacted-to message
 * (cache first, then API fallback), and if this bot authored it, notify them.
 */
async function handleReaction(
  client: ZulipClient,
  session: ZulipSession,
  teamName: TeamName,
  botName: TeammateName,
  botEmail: Email,
  messageId: MessageId,
  reactorUserId: UserId,
  emojiName: EmojiName,
  resolveUserName: (userId: UserId) => DisplayName | undefined,
  onReaction?: EventListenerManagerOptions['onReaction'],
  onError?: (error: unknown) => void,
): Promise<void> {
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

  writeToInbox(teamName, botName, {
    from,
    text,
    summary,
    zulipMessageId: messageId,
    zulipSenderId: reactorUserId,
    ...(msg.type === 'stream'
      ? { zulipStream: msg.display_recipient, zulipTopic: msg.subject }
      : {}),
    zulipSender: reactorName,
  })

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
  const { db, teamName, onRoute, onReaction, onError, signal } = options

  const session = createSession({
    client: botClient,
    eventTypes: [...SESSION_EVENT_TYPES],
    signal,
    handler: {
      onNotification: (event, result) => {
        const msg = event.message

        // Skip messages sent by this bot
        if (msg.sender_email === botEmail) return

        if (msg.type === 'private') {
          // Block bot-to-bot DMs
          if (allBotEmails.has(msg.sender_email)) return

          routeDm(db, teamName, msg, botName).match(
            (dmResult) => {
              if (dmResult.delivered.length > 0) {
                onRoute?.({ sender: msg.sender_full_name, botName })
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

          writeToInbox(teamName, botName, {
            from,
            text: `${content}\n${formatMessageFooter(msg.id, msg.timestamp)}`,
            summary,
            zulipMessageId: msg.id,
            zulipSenderId: msg.sender_id,
            zulipStream: stream,
            zulipTopic: topic,
            zulipSender: senderName,
          })

          // Explicitly follow the topic when this bot is @-mentioned
          if (result.reason === 'mentioned' || result.reason === 'wildcard_mentioned') {
            setUserTopic(botClient, msg.stream_id, topic, TopicVisibility.FOLLOWED)
              .mapErr((err) => onError?.(err))
          }

          onRoute?.({ stream, topic, sender: senderName, botName })
          markAsRead(botClient, [msg.id]).mapErr((markErr) => onError?.(markErr))
        }
      },

      onEvent: (event) => {
        if (isKnownEvent(event) && event.type === 'reaction') {
          if (event.op === 'add') {
            handleReaction(
              botClient,
              session,
              teamName,
              botName,
              botEmail,
              event.message_id,
              event.user_id,
              event.emoji_name,
              (userId) => session.resolveUserId(userId),
              onReaction,
              onError,
            ).catch((err) => onError?.(err))
          }
        }
      },

      onError: (error) => onError?.(error),
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

    const botEmail = teammatesResult.value.find((t) => t.name === name)?.botEmail
    if (!botEmail) {
      options.onError?.(`bot email not found for '${name}'`)
      return
    }

    const session = startBotSession(
      name,
      clientResult.value.client,
      botEmail,
      allBotEmails,
      options,
      () => running.delete(name),
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
