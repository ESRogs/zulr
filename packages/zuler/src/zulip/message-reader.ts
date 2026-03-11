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
}

/** Fetch messages, optionally marking them as read. Shared by `read` and `catch-up` tools. */
export function fetchMessages(
  client: ZulipClient,
  params: GetMessagesParams,
  options?: { markRead?: boolean; streamFallback?: string; topicFallback?: string },
): ResultAsync<readonly FormattedMessage[], ZulipError> {
  const { markRead = true, streamFallback, topicFallback } = options ?? {}

  return getMessages(client, params).andThen((res) => {
    const messages: FormattedMessage[] = res.messages.map((msg) => ({
      id: msg.id,
      stream: msg.type === 'stream' ? msg.display_recipient : (streamFallback ?? ''),
      topic: msg.type === 'stream' ? msg.subject : (topicFallback ?? ''),
      sender: msg.sender_full_name,
      content: msg.content,
      timestamp: msg.timestamp,
    }))

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
      const location = msg.stream ? `${msg.stream}/${msg.topic}` : 'DM'
      const prefix = includeLocation ? `${location} — ` : ''
      return `[${dt}] ${prefix}${msg.sender}: ${msg.content}`
    })
    .join('\n')
}
