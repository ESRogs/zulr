import type { Kysely } from 'kysely'
import { okAsync, type ResultAsync } from 'neverthrow'
import type { ZulipClient } from 'zulip-ts'
import { getEvents, getMembers, getMessages, markAsRead, registerQueue } from 'zulip-ts'
import { type BotManagerError, clientForTeammate } from '../bot-manager.ts'
import type { ZulerDatabase } from '../state/db.ts'
import { writeToInbox } from './inbox.ts'
import { routeMessage } from './routing.ts'

type EventListenerOptions = {
  readonly client: ZulipClient
  readonly db: Kysely<ZulerDatabase>
  readonly teamName: string
  /** Called on each successfully routed message for logging/debugging. */
  readonly onRoute?: (info: {
    readonly stream?: string
    readonly topic?: string
    readonly sender: string
    readonly deliveredTo: readonly string[]
    readonly autoSubscribed: readonly {
      readonly teammate: string
      readonly stream: string
      readonly topic: string
    }[]
  }) => void
  /** Called on reaction events for logging. */
  readonly onReaction?: (info: {
    readonly emoji: string
    readonly op: 'add' | 'remove'
    readonly reactorName: string
    readonly messageId: number
    readonly deliveredTo: readonly string[]
  }) => void
  /** Called on errors for logging. Listener continues after errors. */
  readonly onError?: (error: unknown) => void
  /** If set, the listener stops when this signal is aborted. */
  readonly signal?: AbortSignal
}

const RETRY_DELAY_MS = 5000

/** Cache of per-bot ZulipClients, keyed by teammate name. */
type BotClientCache = Map<string, ZulipClient>

/** Get or create a cached bot client for a teammate. */
function getCachedBotClient(
  cache: BotClientCache,
  db: Kysely<ZulerDatabase>,
  site: string,
  name: string,
): ResultAsync<ZulipClient, BotManagerError> {
  const cached = cache.get(name)
  if (cached) return okAsync(cached)

  return clientForTeammate(db, site, name).map((tc) => {
    cache.set(name, tc.client)
    return tc.client
  })
}

/**
 * Mark a message as read for each teammate that received it,
 * using their cached bot clients. Fire-and-forget — errors go to onError.
 */
function markReadForTeammates(
  cache: BotClientCache,
  db: Kysely<ZulerDatabase>,
  site: string,
  messageId: number,
  teammateNames: readonly string[],
  onError?: (error: unknown) => void,
): void {
  for (const name of teammateNames) {
    getCachedBotClient(cache, db, site, name)
      .andThen((botClient) => markAsRead(botClient, [messageId]))
      .mapErr((err) => onError?.(err))
  }
}

/**
 * Handle a reaction event: fetch the reacted-to message to find its location,
 * then notify subscribed teammates via their inbox.
 */
async function handleReaction(
  client: ZulipClient,
  db: Kysely<ZulerDatabase>,
  teamName: string,
  messageId: number,
  reactorUserId: number,
  emojiName: string,
  resolveUserName: (userId: number) => Promise<string>,
  onReaction?: EventListenerOptions['onReaction'],
  onError?: (error: unknown) => void,
): Promise<void> {
  // Fetch the message to find location and sender
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

  // Build the notification text
  const preview = msg.content.length > 40 ? `${msg.content.slice(0, 40)}...` : msg.content

  // Find teammates who sent this message (check if sender is a registered bot)
  const { listTeammates } = await import('../state/teammates.ts')
  const teammatesResult = await listTeammates(db)
  if (teammatesResult.isErr()) return

  const senderBot = teammatesResult.value.find((t) => t.botEmail === msg.sender_email)

  if (!senderBot) return // Reaction to a non-teammate message — ignore

  const from =
    msg.type === 'stream'
      ? `zulip:${msg.display_recipient}/${msg.subject}:${reactorName}`
      : `zulip:${reactorName}`

  const summary = `:${emojiName}: on \u201c${preview}\u201d`
  const text = `${summary}\n[msg:${messageId}]`

  writeToInbox(teamName, senderBot.name, {
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
    deliveredTo: [senderBot.name],
  })
}

/**
 * Start listening for Zulip events and route inbound messages to
 * Claude Code teammate inbox files.
 *
 * Registers an event queue, then long-polls for events in a loop.
 * On queue expiration or errors, re-registers and continues.
 * Stops when the AbortSignal is aborted.
 *
 * After delivering a message to a teammate's inbox, marks it as read
 * on Zulip using the teammate's bot API key, so that catch-up via
 * "first_unread" anchor works correctly after restart.
 */
export async function startEventListener(options: EventListenerOptions): Promise<void> {
  const { client, db, teamName, onRoute, onReaction, onError, signal } = options
  const botClientCache: BotClientCache = new Map()
  let membersMap: Map<number, string> | null = null

  async function resolveUserName(userId: number): Promise<string> {
    if (membersMap) {
      const name = membersMap.get(userId)
      if (name) return name
    }
    const result = await getMembers(client)
    if (result.isOk()) {
      membersMap = new Map(result.value.members.map((m) => [m.user_id, m.full_name]))
      return membersMap.get(userId) ?? `user ${userId}`
    }
    return `user ${userId}`
  }

  while (!signal?.aborted) {
    // Register a new event queue
    const regResult = await registerQueue(client, { eventTypes: ['message', 'reaction'] })

    if (regResult.isErr()) {
      onError?.(regResult.error)
      await sleep(RETRY_DELAY_MS, signal)
      continue
    }

    const { queue_id: queueId, last_event_id: initialLastEventId } = regResult.value
    let lastEventId = initialLastEventId

    // Poll loop for this queue
    while (!signal?.aborted) {
      const eventsResult = await getEvents(client, { queueId, lastEventId })

      if (eventsResult.isErr()) {
        const err = eventsResult.error
        // BAD_EVENT_QUEUE_ID means the queue expired — break to re-register
        if (err.type === 'api' && err.code === 'BAD_EVENT_QUEUE_ID') {
          break
        }
        onError?.(err)
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
            client,
            db,
            teamName,
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

        const result = await routeMessage(db, teamName, event.message)

        if (result.delivered.length > 0) {
          const deliveredNames = result.delivered.map((d) => d.teammate)
          const msg = event.message
          onRoute?.({
            stream: msg.type === 'stream' ? msg.display_recipient : undefined,
            topic: msg.type === 'stream' ? msg.subject : undefined,
            sender: msg.sender_full_name,
            deliveredTo: deliveredNames,
            autoSubscribed: result.autoSubscribed,
          })

          // Mark as read for each teammate (fire-and-forget, errors go to onError)
          markReadForTeammates(
            botClientCache,
            db,
            client.config.site,
            result.messageId,
            deliveredNames,
            onError,
          )
        }
      }
    }
  }
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
