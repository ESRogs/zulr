import { okAsync, type ResultAsync } from 'neverthrow'
import type {
  ChannelName,
  DisplayName,
  EmojiName,
  GetMessagesParams,
  Message,
  MessageId,
  Reaction,
  TopicName,
  UnixEpochSeconds,
  UserId,
  ZulipClient,
  ZulipError,
} from 'zulip-ts'
import { getMessages, markAsRead } from 'zulip-ts'

export type FormattedReaction = {
  readonly emoji: EmojiName
  readonly users: readonly string[]
}

type SharedMessageFields = {
  readonly id: MessageId
  readonly sender: DisplayName
  readonly content: string
  readonly timestamp: UnixEpochSeconds
  readonly reactions?: readonly FormattedReaction[]
}

export type FormattedStreamMessage = SharedMessageFields & {
  readonly type: 'stream'
  readonly stream: ChannelName
  readonly topic: TopicName
}

export type FormattedDmMessage = SharedMessageFields & {
  readonly type: 'dm'
  readonly dmWith: string
  readonly isGroupDm: boolean
}

export type FormattedMessage = FormattedStreamMessage | FormattedDmMessage

/** Group raw reactions by emoji name, resolving user IDs to names. */
function aggregateReactions(
  raw: readonly Reaction[],
  resolveUserId?: (id: UserId) => string | undefined,
): FormattedReaction[] {
  const byEmoji = new Map<EmojiName, string[]>()
  for (const r of raw) {
    const name = resolveUserId?.(r.user_id) ?? `user ${r.user_id}`
    const existing = byEmoji.get(r.emoji_name)
    if (existing) {
      existing.push(name)
    } else {
      byEmoji.set(r.emoji_name, [name])
    }
  }
  return [...byEmoji].map(([emoji, users]) => ({ emoji, users }))
}

/** Build the reactions field for a FormattedMessage, returning undefined when empty. */
function formatReactionsField(
  msg: Message,
  resolveUserId?: (id: UserId) => string | undefined,
): FormattedReaction[] | undefined {
  if (msg.reactions.length === 0) return undefined
  const reactions = msg.reactions
  return aggregateReactions(reactions, resolveUserId)
}

/** Fetch messages, optionally marking them as read. Shared by `read` and `catch-up` tools. */
export function fetchMessages(
  client: ZulipClient,
  params: GetMessagesParams,
  options?: {
    markRead?: boolean
    streamFallback?: ChannelName
    topicFallback?: TopicName
    botUserId?: UserId | null
    resolveUserId?: (id: UserId) => string | undefined
  },
): ResultAsync<readonly FormattedMessage[], ZulipError> {
  const { markRead = true, streamFallback, topicFallback, botUserId, resolveUserId } = options ?? {}

  return getMessages(client, params).andThen((res) => {
    const messages: FormattedMessage[] = res.messages.map((msg) => {
      if (msg.type === 'stream') {
        return {
          type: 'stream' as const,
          id: msg.id,
          stream: msg.display_recipient || (streamFallback ?? ('' as ChannelName)),
          topic: msg.subject || (topicFallback ?? ('' as TopicName)),
          sender: msg.sender_full_name,
          content: msg.content,
          timestamp: msg.timestamp,
          reactions: formatReactionsField(msg, resolveUserId),
        }
      }
      // DM — extract the other participants (exclude the bot making the API call)
      // If botUserId is unknown, skip enrichment rather than guessing wrong
      const others =
        botUserId != null
          ? msg.display_recipient.filter((r) => r.id !== botUserId).map((r) => r.full_name)
          : []
      return {
        type: 'dm' as const,
        id: msg.id,
        sender: msg.sender_full_name,
        content: msg.content,
        timestamp: msg.timestamp,
        dmWith: others.length > 0 ? others.join(', ') : 'unknown',
        isGroupDm: msg.display_recipient.length > 2,
        reactions: formatReactionsField(msg, resolveUserId),
      }
    })

    if (markRead && messages.length > 0) {
      return markAsRead(
        client,
        messages.map((m) => m.id),
      ).map(() => messages)
    }

    return okAsync(messages)
  })
}

const MSG_FOOTER_RE = /\n\[msg:\d+ ts:[^\]]+\]$/

export function formatMessageFooter(id: MessageId, timestamp: UnixEpochSeconds): string {
  const ts = new Date(timestamp * 1000).toISOString()
  return `[msg:${id} ts:${ts}]`
}

export function stripMessageFooter(text: string): string {
  return text.replace(MSG_FOOTER_RE, '')
}

export function formatMessages(
  messages: readonly FormattedMessage[],
  includeLocation: boolean,
): string {
  return messages
    .map((msg) => {
      const dt = new Date(msg.timestamp * 1000).toISOString()
      const location =
        msg.type === 'stream' ? `${msg.stream}/${msg.topic}` : `DM with ${msg.dmWith}`
      const prefix = includeLocation ? `${location} — ` : ''
      const reactionsLine = msg.reactions
        ? `\n  reactions: ${msg.reactions.map((r) => `:${r.emoji}: ${r.users.join(', ')}`).join('  ')}`
        : ''
      const footer = msg.id > 0 ? `\n${formatMessageFooter(msg.id, msg.timestamp)}` : ''
      return `[${dt}] ${prefix}${msg.sender}: ${msg.content}${reactionsLine}${footer}`
    })
    .join('\n')
}
