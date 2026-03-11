import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { ZulipClient, ZulipError } from 'zulip-ts'
import { getMessages, getStreams, updateMessage } from 'zulip-ts'
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
  stream: string,
  topic: string,
): ResultAsync<number, ZulipError | string> {
  return getMessages(client, {
    anchor: 'newest',
    numBefore: 1,
    numAfter: 0,
    narrow: [
      { operator: 'stream', operand: stream },
      { operator: 'topic', operand: topic },
    ],
    applyMarkdown: false,
  }).andThen((res) => {
    const msg = res.messages[0]
    if (!msg) return errAsync<number, string>(`no messages found in ${stream}/${topic}`)
    return okAsync(msg.id)
  })
}

export function registerResolveTopicTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'resolve-topic',
    {
      description: 'Mark a Zulip topic as resolved (adds ✔ prefix). Use unresolve-topic to undo.',
      inputSchema: z.object({
        stream: z.string().describe('Channel name'),
        topic: z.string().describe('Topic name'),
      }),
    },
    async ({ stream, topic }) => {
      if (topic.startsWith(RESOLVED_PREFIX)) {
        return errorResult('topic is already resolved')
      }

      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      const found = await findMessageIdInTopic(client, stream, topic)
      if (found.isErr()) return errorResult(formatError(found.error))

      const result = await updateMessage(client, found.value, {
        topic: `${RESOLVED_PREFIX}${topic}`,
        propagateMode: 'change_all',
      })

      return result.match(
        () => textResult(`resolved: ${stream}/${RESOLVED_PREFIX}${topic}`),
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
        stream: z.string().describe('Channel name'),
        topic: z.string().describe('Topic name (with or without ✔ prefix)'),
      }),
    },
    async ({ stream, topic }) => {
      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      const resolvedTopic = topic.startsWith(RESOLVED_PREFIX) ? topic : `${RESOLVED_PREFIX}${topic}`
      const unresolvedTopic = topic.startsWith(RESOLVED_PREFIX)
        ? topic.slice(RESOLVED_PREFIX.length)
        : topic

      const found = await findMessageIdInTopic(client, stream, resolvedTopic)
      if (found.isErr()) return errorResult(formatError(found.error))

      const result = await updateMessage(client, found.value, {
        topic: unresolvedTopic,
        propagateMode: 'change_all',
      })

      return result.match(
        () => textResult(`unresolved: ${stream}/${unresolvedTopic}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerMoveTopicTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'move-topic',
    {
      description: 'Move all messages in a topic to a different channel.',
      inputSchema: z.object({
        stream: z.string().describe('Source channel name'),
        topic: z.string().describe('Topic name'),
        toStream: z.string().describe('Destination channel name'),
        toTopic: z.string().optional().describe('New topic name (defaults to keeping the same)'),
      }),
    },
    async ({ stream, topic, toStream, toTopic }) => {
      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      const streamsResult = await getStreams(client)
      if (streamsResult.isErr()) return errorResult(formatError(streamsResult.error))

      const destStream = streamsResult.value.streams.find((s) => s.name === toStream)
      if (!destStream) return errorResult(`destination channel "${toStream}" not found`)

      const found = await findMessageIdInTopic(client, stream, topic)
      if (found.isErr()) return errorResult(formatError(found.error))

      const destTopic = toTopic ?? topic
      const result = await updateMessage(client, found.value, {
        streamId: destStream.stream_id,
        topic: destTopic,
        propagateMode: 'change_all',
        sendNotificationToOldThread: true,
        sendNotificationToNewThread: true,
      })

      return result.match(
        () => textResult(`moved ${stream}/${topic} → ${toStream}/${destTopic}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
