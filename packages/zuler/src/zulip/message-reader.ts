import { okAsync, type ResultAsync } from 'neverthrow'
import type { GetMessagesParams, ZulipClient, ZulipError } from 'zulip-ts'
import { getMessages, markAsRead } from 'zulip-ts'

export type FormattedMessage = {
  readonly id: number
  readonly stream: string
  readonly topic: string
  readonly sender: string
  readonly content: string
  readonly timestamp: number
  readonly dmWith?: string
  readonly isGroupDm?: boolean
}

/** Fetch messages, optionally marking them as read. Shared by `read` and `catch-up` tools. */
export function fetchMessages(
  client: ZulipClient,
  params: GetMessagesParams,
  options?: {
    markRead?: boolean
    streamFallback?: string
    topicFallback?: string
    botUserId?: number | null
  },
): ResultAsync<readonly FormattedMessage[], ZulipError> {
  const { markRead = true, streamFallback, topicFallback, botUserId } = options ?? {}

  return getMessages(client, params).andThen((res) => {
    const messages: FormattedMessage[] = res.messages.map((msg) => {
      if (msg.type === 'stream') {
        return {
          id: msg.id,
          stream: msg.display_recipient || (streamFallback ?? ''),
          topic: msg.subject || (topicFallback ?? ''),
          sender: msg.sender_full_name,
          content: msg.content,
          timestamp: msg.timestamp,
        }
      }
      // DM — extract the other participants (exclude the bot making the API call)
      // If botUserId is unknown, skip enrichment rather than guessing wrong
      const others = botUserId
        ? msg.display_recipient.filter((r) => r.id !== botUserId).map((r) => r.full_name)
        : []
      return {
        id: msg.id,
        stream: '',
        topic: '',
        sender: msg.sender_full_name,
        content: msg.content,
        timestamp: msg.timestamp,
        dmWith: others.length > 0 ? others.join(', ') : undefined,
        isGroupDm: msg.display_recipient.length > 2,
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

export function formatMessages(
  messages: readonly FormattedMessage[],
  includeLocation: boolean,
): string {
  return messages
    .map((msg) => {
      const dt = new Date(msg.timestamp * 1000).toISOString()
      const location = msg.stream
        ? `${msg.stream}/${msg.topic}`
        : msg.dmWith
          ? `DM with ${msg.dmWith}`
          : 'DM'
      const prefix = includeLocation ? `${location} — ` : ''
      return `[${dt}] ${prefix}${msg.sender}: ${msg.content}`
    })
    .join('\n')
}
