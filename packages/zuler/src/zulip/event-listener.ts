import type { Kysely } from 'kysely'
import type { EventId, MessageId, UserId, ZulipClient } from 'zulip-ts'
import { getEvents, getMembers, getMessages, markAsRead, registerQueue } from 'zulip-ts'
import { clientForTeammate } from '../bot-manager.ts'
import type { ZulerDatabase } from '../state/db.ts'
import { listTeammates, type Teammate } from '../state/teammates.ts'
import { writeToInbox } from './inbox.ts'
import { formatMessageFooter } from './message-reader.ts'
import { routeDm, sanitizeSummary, truncate } from './routing.ts'

type EventListenerManagerOptions = {
  readonly db: Kysely<ZulerDatabase>
  readonly teamName: string
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

const RETRY_DELAY_MS = 5000

/**
 * Handle a reaction event for a specific bot: fetch the reacted-to message,
 * and if this bot authored it, notify them.
 */
async function handleReaction(
  client: ZulipClient,
  teamName: string,
  botName: string,
  botEmail: string,
  messageId: MessageId,
  reactorUserId: UserId,
  emojiName: string,
  resolveUserName: (userId: UserId) => Promise<string>,
  onReaction?: EventListenerManagerOptions['onReaction'],
  onError?: (error: unknown) => void,
): Promise<void> {
  const msgResult = await getMessages(client, {
    anchor: messageId,
    numBefore: 0,
    numAfter: 0,
    narrow: [{ operator: 'id', operand: messageId }],
    applyMarkdown: false,
  })

  if (msgResult.isErr()) {
    onError?.(msgResult.error)
    return
  }

  const msg = msgResult.value.messages[0]
  if (!msg) return

  const reactorName = await resolveUserName(reactorUserId)

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
 * Run a single bot's event listener loop. Registers its own event queue
 * using the bot's client and long-polls for events.
 */
async function runBotListener(
  botName: string,
  botClient: ZulipClient,
  botEmail: string,
  allBotEmails: ReadonlySet<string>,
  options: EventListenerManagerOptions,
): Promise<void> {
  const { db, teamName, onRoute, onReaction, onError, signal } = options
  let membersMap: Map<UserId, string> | null = null

  async function resolveUserName(userId: UserId): Promise<string> {
    if (membersMap) {
      const name = membersMap.get(userId)
      if (name) return name
    }
    const result = await getMembers(botClient)
    if (result.isOk()) {
      membersMap = new Map(result.value.members.map((m) => [m.user_id, m.full_name]))
      return membersMap.get(userId) ?? `user ${userId}`
    }
    return `user ${userId}`
  }

  while (!signal?.aborted) {
    const regResult = await registerQueue(botClient, { eventTypes: ['message', 'reaction'] })

    if (regResult.isErr()) {
      onError?.(regResult.error)
      await sleep(RETRY_DELAY_MS, signal)
      continue
    }

    const { queue_id: queueId, last_event_id: initialLastEventId } = regResult.value
    let lastEventId: EventId = initialLastEventId

    while (!signal?.aborted) {
      const eventsResult = await getEvents(botClient, { queueId, lastEventId })

      if (eventsResult.isErr()) {
        const evtErr = eventsResult.error
        if (evtErr.type === 'api' && evtErr.code === 'BAD_EVENT_QUEUE_ID') {
          break
        }
        onError?.(evtErr)
        await sleep(RETRY_DELAY_MS, signal)
        continue
      }

      for (const event of eventsResult.value.events) {
        lastEventId = event.id

        // Handle reaction events
        if (
          event.type === 'reaction' &&
          event.op === 'add' &&
          event.message_id != null &&
          event.user_id != null &&
          event.emoji_name
        ) {
          await handleReaction(
            botClient,
            teamName,
            botName,
            botEmail,
            event.message_id,
            event.user_id,
            event.emoji_name,
            resolveUserName,
            onReaction,
            onError,
          )
          continue
        }

        if (event.type !== 'message' || !event.message) continue

        const msg = event.message

        // Skip messages sent by this bot
        if (msg.sender_email === botEmail) continue

        if (msg.type === 'private') {
          // Block bot-to-bot DMs
          if (allBotEmails.has(msg.sender_email)) continue

          // DM — use existing routeDm logic
          const result = await routeDm(db, teamName, msg, botName)
          if (result.delivered.length > 0) {
            onRoute?.({
              sender: msg.sender_full_name,
              botName,
            })
            markAsRead(botClient, [msg.id]).mapErr((markErr) => onError?.(markErr))
          }
        } else {
          // Stream message — bot is subscribed, so deliver it
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

          onRoute?.({
            stream,
            topic,
            sender: senderName,
            botName,
          })

          // Mark as read
          markAsRead(botClient, [msg.id]).mapErr((markErr) => onError?.(markErr))
        }
      }
    }
  }
}

/**
 * Manages per-bot event listeners. Start listeners for all registered bots,
 * and provides a method to start a listener for a newly registered bot.
 */
export type EventListenerManager = {
  /** Start a listener for a specific bot by name. No-op if already running. */
  readonly startBot: (name: string) => Promise<void>
  /** Start listeners for all registered bots. */
  readonly startAll: () => Promise<void>
}

export function createEventListenerManager(
  options: EventListenerManagerOptions,
): EventListenerManager {
  const running = new Set<string>()
  /** Cached set of all bot emails for bot-to-bot DM blocking. Refreshed on startAll/startBot. */
  let allBotEmails = new Set<string>()

  async function refreshBotEmails(): Promise<readonly Teammate[]> {
    const result = await listTeammates(options.db)
    if (result.isErr()) return []
    const teammates = result.value
    allBotEmails = new Set(teammates.map((t) => t.botEmail))
    return teammates
  }

  async function startBot(name: string): Promise<void> {
    if (running.has(name)) return

    const clientResult = await clientForTeammate(options.db, options.site, name)
    if (clientResult.isErr()) {
      options.onError?.(
        `failed to get client for bot '${name}': ${JSON.stringify(clientResult.error)}`,
      )
      return
    }

    // Refresh bot emails so the new bot is included in the set
    const teammates = await refreshBotEmails()
    const botEmail = teammates.find((t) => t.name === name)?.botEmail
    if (!botEmail) {
      options.onError?.(`bot email not found for '${name}'`)
      return
    }

    running.add(name)
    // Run in background — don't await
    runBotListener(name, clientResult.value.client, botEmail, allBotEmails, options).catch(
      (err) => {
        options.onError?.(err)
        running.delete(name)
      },
    )
  }

  async function startAll(): Promise<void> {
    const teammates = await refreshBotEmails()
    if (teammates.length === 0) return

    await Promise.all(teammates.map((t) => startBot(t.name)))
  }

  return { startBot, startAll }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
