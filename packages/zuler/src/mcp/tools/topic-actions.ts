import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { ChannelName, MessageId, TopicName, ZulipClient } from 'zulip-ts'
import { getMessages, updateMessage } from 'zulip-ts'
import {
  errorResult,
  formatError,
  notConfiguredResult,
  type ToolContext,
  textResult,
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
        channel: z.string().describe('Channel name'),
        topic: z.string().describe('Topic name'),
      }),
    },
    async ({ channel: rawChannel, topic: rawTopic }) => {
      const channel = rawChannel as ChannelName
      const topic = rawTopic as TopicName
      if (topic.startsWith(RESOLVED_PREFIX)) {
        return errorResult('topic is already resolved')
      }

      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

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
        channel: z.string().describe('Channel name'),
        topic: z.string().describe('Topic name (with or without ✔ prefix)'),
      }),
    },
    async ({ channel: rawChannel, topic: rawTopic }) => {
      const channel = rawChannel as ChannelName
      const topic = rawTopic as TopicName
      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

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
        channel: z.string().describe('Source channel name'),
        topic: z.string().describe('Topic name'),
        toChannel: z.string().describe('Destination channel name'),
        toTopic: z.string().optional().describe('New topic name (defaults to keeping the same)'),
      }),
    },
    async ({ channel: rawChannel, topic: rawTopic, toChannel, toTopic: rawToTopic }) => {
      const channel = rawChannel as ChannelName
      const topic = rawTopic as TopicName
      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      const destResult = await ctx.resolveChannel(toChannel)
      if (destResult.isErr()) return errorResult(destResult.error)

      const found = await findMessageIdInTopic(client, channel, topic)
      if (found.isErr()) return errorResult(found.error)

      const destTopic = (rawToTopic ?? topic) as TopicName
      const result = await updateMessage(client, found.value, {
        streamId: destResult.value.stream_id,
        topic: destTopic,
        propagateMode: 'change_all',
        sendNotificationToOldThread: true,
        sendNotificationToNewThread: true,
      })

      return result.match(
        () => textResult(`moved ${channel}/${topic} → ${toChannel}/${destTopic}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
