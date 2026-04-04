import { z } from 'zod'
import { streamNarrowKey, type ZulipSession } from 'zulip-client-ts'
import { type ChannelName, markAsRead, type StreamId, type TopicName, type UserId } from 'zulip-ts'
import type { TeammateName } from '../../tagged-types.ts'
import {
  consumeAllUnreadMessages,
  consumeUnreadDmMessages,
  consumeUnreadInboxMessages,
  inboxToFormattedMessages,
  mergeWithInbox,
} from '../../zulip/inbox.ts'
import {
  type FormattedMessage,
  fetchMessages,
  formatMessages,
  toFormattedMessage,
} from '../../zulip/message-reader.ts'
import {
  buildUserIdResolver,
  errorResult,
  getErrorMessage,
  type ToolContext,
  type ToolRegistrar,
  textResult,
  zBool,
  zChannelName,
  zTeammateName,
  zTopicName,
} from '../helpers.ts'

export function registerReadTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'read',
    {
      description:
        'Fetch recent messages from a Zulip channel/topic or DM conversation. For channel messages, provide "channel" and "topic". For DMs, provide "user" (ID, name, or email). Uses the sender bot API key and marks fetched messages as read. Set inboxOnly to read just the unread messages in your teammate inbox (optionally filtered by channel/topic) — this clears the posting gate without fetching from Zulip.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name (uses their bot for read tracking)'),
        channel: zChannelName.optional().describe('Channel name'),
        topic: zTopicName.optional().describe('Topic name'),
        user: z
          .union([z.number(), z.string()])
          .optional()
          .describe('User ID, full name, or email (for DM conversations)'),
        count: z.coerce.number().optional().default(10).describe('Number of messages to fetch'),
        inboxOnly: zBool
          .optional()
          .default(false)
          .describe(
            'Read only unread messages from your teammate inbox. Optionally filter by channel/topic. Clears the posting gate.',
          ),
      }),
    },
    async ({ sender, channel, topic, user, count, inboxOnly }) => {
      if (inboxOnly) {
        return readInboxOnly(ctx, sender, channel, topic)
      }
      if (user !== undefined) {
        const resolveResult = await ctx.cache.resolveUser(user)
        if (resolveResult.isErr()) {
          return errorResult(resolveResult.error)
        }
        return readDms(ctx, sender, resolveResult.value.user_id, count)
      }
      if (channel && topic) {
        return readStream(ctx, sender, channel, topic, count)
      }
      return errorResult('provide either "channel" and "topic" (for channels) or "user" (for DMs)')
    },
  )
}

function readInboxOnly(
  ctx: ToolContext,
  sender: TeammateName,
  channel?: ChannelName,
  topic?: TopicName,
) {
  const { teamName } = ctx.config
  let consumed: ReturnType<typeof consumeAllUnreadMessages>

  if (channel && topic) {
    consumed = consumeUnreadInboxMessages(teamName, sender, channel, topic)
  } else {
    consumed = consumeAllUnreadMessages(teamName, sender)
  }

  if (consumed.length === 0) {
    const scope = channel && topic ? ` in ${channel}/${topic}` : ''
    return textResult(`(no unread inbox messages${scope})`)
  }

  const formatted = inboxToFormattedMessages(consumed)
  const sorted = formatted.toSorted((a, b) => a.timestamp - b.timestamp)
  const body = formatMessages(sorted, false)
  const scope = channel && topic ? ` in ${channel}/${topic}` : ''
  return textResult(
    `(${consumed.length} unread inbox message${consumed.length === 1 ? '' : 's'}${scope})\n\n${body}`,
  )
}

/**
 * Check if the session cache can satisfy a stream topic read request.
 * Returns formatted messages if cache has enough data, undefined otherwise.
 */
function tryReadFromCache(
  session: ZulipSession | undefined,
  streamId: StreamId,
  topic: TopicName,
  count: number,
  resolveUserId?: (id: UserId) => string | undefined,
): readonly FormattedMessage[] | undefined {
  if (!session) return undefined
  if (!session.isSubscribed(streamId)) return undefined
  if (session.getRegisteredAt() === undefined) return undefined

  const key = streamNarrowKey(streamId, topic)
  if (!session.canServeFromCache(key, count)) return undefined

  const cached = session.getMessages(key, count)
  return cached.map((msg) => toFormattedMessage(msg, { resolveUserId }))
}

async function readStream(
  ctx: ToolContext,
  sender: TeammateName,
  stream: ChannelName,
  topic: TopicName,
  count: number,
) {
  const botClientResult = await ctx.credentials.getTeammateClient(sender)
  if (botClientResult.isErr()) {
    return errorResult(botClientResult.error)
  }

  const botClient = botClientResult.value.client
  // eslint-disable-next-line neverthrow/must-use-result
  const resolveUserId = (await buildUserIdResolver(ctx)).unwrapOr(() => undefined)

  // Try cache first — if the session has enough cached messages, skip the API
  const session = ctx.getEventListenerManager()?.getSession(sender)

  const channelResult = await ctx.cache.resolveChannel(stream)
  const streamId = channelResult.isOk() ? channelResult.value.stream_id : undefined

  let allMessages: readonly FormattedMessage[]

  const cached =
    streamId !== undefined
      ? tryReadFromCache(session, streamId, topic, count, resolveUserId)
      : undefined

  if (cached) {
    // Cache hit — merge with inbox and serve
    const inboxMessages = consumeUnreadInboxMessages(ctx.config.teamName, sender, stream, topic)
    const inboxFormatted = inboxToFormattedMessages(inboxMessages)
    allMessages = mergeWithInbox([...cached], inboxFormatted)
  } else {
    // Cache miss — fetch from API

    const fetchResult = await fetchMessages(
      botClient,
      {
        anchor: 'newest',
        numBefore: count + 1,
        numAfter: 0,
        narrow: [
          { operator: 'stream', operand: stream },
          { operator: 'topic', operand: topic },
        ],
        applyMarkdown: false,
      },
      { markRead: false, resolveUserId },
    )

    if (fetchResult.isErr()) {
      return errorResult(getErrorMessage(fetchResult.error))
    }

    const inboxMessages = consumeUnreadInboxMessages(ctx.config.teamName, sender, stream, topic)
    const inboxFormatted = inboxToFormattedMessages(inboxMessages)
    allMessages = mergeWithInbox([...fetchResult.value], inboxFormatted)
  }

  if (allMessages.length === 0) {
    return textResult(`(no messages in ${stream}/${topic})`)
  }

  const hasMore = allMessages.length > count
  const sorted = allMessages.toSorted((a, b) => a.timestamp - b.timestamp)
  const displayed = sorted.slice(-count)

  const header = hasMore
    ? `(showing ${displayed.length} most recent — pass a larger count to see more history)\n\n`
    : `(showing all ${displayed.length} message${displayed.length === 1 ? '' : 's'})\n\n`

  const body = `${header}${formatMessages(displayed, false)}`

  const displayedZulipIds = displayed.filter((m) => m.id > 0).map((m) => m.id)
  if (displayedZulipIds.length > 0) {
    const markResult = await markAsRead(botClient, displayedZulipIds)
    if (markResult.isErr()) {
      return textResult(`(warning: failed to mark messages as read)\n${body}`)
    }
  }

  return textResult(body)
}

async function readDms(ctx: ToolContext, sender: TeammateName, userId: UserId, count: number) {
  const botClientResult = await ctx.credentials.getTeammateClient(sender)
  if (botClientResult.isErr()) {
    return errorResult(botClientResult.error)
  }

  const { client: botClient, botUserId } = botClientResult.value

  // eslint-disable-next-line neverthrow/must-use-result
  const resolveUserId = (await buildUserIdResolver(ctx)).unwrapOr(() => undefined)

  const fetchResult = await fetchMessages(
    botClient,
    {
      anchor: 'newest',
      numBefore: count + 1,
      numAfter: 0,
      narrow: [{ operator: 'pm-with', operand: [userId] }],
      applyMarkdown: false,
    },
    { markRead: false, botUserId, resolveUserId },
  )

  if (fetchResult.isErr()) {
    return errorResult(getErrorMessage(fetchResult.error))
  }

  // Consume unread DM inbox messages from this user
  consumeUnreadDmMessages(ctx.config.teamName, sender, userId)

  const allMessages = [...fetchResult.value]

  if (allMessages.length === 0) {
    return textResult('(no DMs with this user)')
  }

  const hasMore = allMessages.length > count
  const sorted = allMessages.toSorted((a, b) => a.timestamp - b.timestamp)
  const displayed = sorted.slice(-count)

  const header = hasMore
    ? `(showing ${displayed.length} most recent — pass a larger count to see more history)\n\n`
    : `(showing all ${displayed.length} message${displayed.length === 1 ? '' : 's'})\n\n`

  const body = `${header}${formatMessages(displayed, false)}`

  const displayedZulipIds = displayed.filter((m) => m.id > 0).map((m) => m.id)
  if (displayedZulipIds.length > 0) {
    const markResult = await markAsRead(botClient, displayedZulipIds)
    if (markResult.isErr()) {
      return textResult(`(warning: failed to mark messages as read)\n${body}`)
    }
  }

  return textResult(body)
}
