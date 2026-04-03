import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { ChannelName, MessageId, TopicName, ZulipClient } from 'zulip-ts'
import { getMessages, updateMessage } from 'zulip-ts'
import {
  errorResult,
  formatError,
  type ToolContext,
  textResult,
  zBool,
  zChannelName,
  zTeammateName,
  zTopicName,
} from '../helpers.ts'

const RESOLVED_PREFIX = '✔ '

/** Find any message ID in a topic (needed for updateMessage). */
function findMessageIdInTopic(
  client: ZulipClient,
  channel: ChannelName,
  topic: TopicName,
): ResultAsync<MessageId, string> {
  return getMessages(client, {
    anchor: 'newest',
    numBefore: 1,
    numAfter: 0,
    narrow: [
      { operator: 'stream', operand: channel },
      { operator: 'topic', operand: topic },
    ],
    applyMarkdown: false,
  })
    .mapErr(formatError)
    .andThen((res) => {
      const msg = res.messages[0]
      if (!msg) return errAsync(`no messages found in ${channel}/${topic}`)
      return okAsync(msg.id)
    })
}

export function registerResolveTopicTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'resolve-topic',
    {
      description: 'Mark a Zulip topic as resolved (adds ✔ prefix). Use unresolve-topic to undo.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
        topic: zTopicName.describe('Topic name'),
      }),
    },
    async ({ sender, channel, topic }) => {
      if (topic.startsWith(RESOLVED_PREFIX)) {
        return errorResult('topic is already resolved')
      }

      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)
      const { client } = clientResult.value

      const found = await findMessageIdInTopic(client, channel, topic)
      if (found.isErr()) return errorResult(found.error)

      const result = await updateMessage(client, found.value, {
        topic: `${RESOLVED_PREFIX}${topic}` as TopicName,
        propagateMode: 'change_all',
      })

      return result.match(
        () => textResult(`resolved: ${channel}/${RESOLVED_PREFIX}${topic}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerUnresolveTopicTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'unresolve-topic',
    {
      description: 'Remove the resolved (✔) prefix from a Zulip topic.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
        topic: zTopicName.describe('Topic name (with or without ✔ prefix)'),
      }),
    },
    async ({ sender, channel, topic }) => {
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)
      const { client } = clientResult.value

      const resolvedTopic = (
        topic.startsWith(RESOLVED_PREFIX) ? topic : `${RESOLVED_PREFIX}${topic}`
      ) as TopicName
      const unresolvedTopic = (
        topic.startsWith(RESOLVED_PREFIX) ? topic.slice(RESOLVED_PREFIX.length) : topic
      ) as TopicName

      const found = await findMessageIdInTopic(client, channel, resolvedTopic)
      if (found.isErr()) return errorResult(found.error)

      const result = await updateMessage(client, found.value, {
        topic: unresolvedTopic,
        propagateMode: 'change_all',
      })

      return result.match(
        () => textResult(`unresolved: ${channel}/${unresolvedTopic}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerMoveTopicTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'move-topic',
    {
      description:
        'Move all messages in a topic to a different channel. Optionally rename the topic during the move via "toTopic".',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Source channel name'),
        topic: zTopicName.describe('Topic name'),
        toChannel: z.string().describe('Destination channel name'),
        toTopic: zTopicName.optional().describe('New topic name (defaults to keeping the same)'),
        notifyOldTopic: zBool
          .optional()
          .default(false)
          .describe('Send a notification to the old topic (default: false)'),
        notifyNewTopic: zBool
          .optional()
          .default(true)
          .describe('Send a notification to the new topic (default: true)'),
      }),
    },
    async ({
      sender,
      channel,
      topic,
      toChannel,
      toTopic: rawToTopic,
      notifyOldTopic,
      notifyNewTopic,
    }) => {
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)
      const { client } = clientResult.value

      const destResult = await ctx.resolveChannel(toChannel)
      if (destResult.isErr()) return errorResult(destResult.error)

      const found = await findMessageIdInTopic(client, channel, topic)
      if (found.isErr()) return errorResult(found.error)

      const destTopic = rawToTopic ?? topic
      const result = await updateMessage(client, found.value, {
        streamId: destResult.value.stream_id,
        topic: destTopic,
        propagateMode: 'change_all',
        sendNotificationToOldThread: notifyOldTopic,
        sendNotificationToNewThread: notifyNewTopic,
      })

      return result.match(
        () => textResult(`moved ${channel}/${topic} → ${toChannel}/${destTopic}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
