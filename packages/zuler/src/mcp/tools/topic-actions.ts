import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getMessages, getStreams, updateMessage } from 'zulip-ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

const RESOLVED_PREFIX = '✔ '
const NOT_CONFIGURED = 'Zulip credentials not configured. Call the init tool first.'

/** Find any message ID in a topic (needed for updateMessage). */
async function findMessageIdInTopic(
  ctx: ToolContext,
  stream: string,
  topic: string,
): Promise<{ ok: true; messageId: number } | { ok: false; error: string }> {
  const client = ctx.getAdminClient()
  if (!client) return { ok: false, error: NOT_CONFIGURED }

  const result = await getMessages(client, {
    anchor: 'newest',
    numBefore: 1,
    numAfter: 0,
    narrow: [
      { operator: 'stream', operand: stream },
      { operator: 'topic', operand: topic },
    ],
    applyMarkdown: false,
  })

  if (result.isErr()) return { ok: false, error: formatError(result.error) }

  const msg = result.value.messages[0]
  if (!msg) return { ok: false, error: `no messages found in ${stream}/${topic}` }

  return { ok: true, messageId: msg.id }
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
      if (!client) return errorResult(NOT_CONFIGURED)

      const found = await findMessageIdInTopic(ctx, stream, topic)
      if (!found.ok) return errorResult(found.error)

      const result = await updateMessage(client, found.messageId, {
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
      if (!client) return errorResult(NOT_CONFIGURED)

      const resolvedTopic = topic.startsWith(RESOLVED_PREFIX) ? topic : `${RESOLVED_PREFIX}${topic}`
      const unresolvedTopic = topic.startsWith(RESOLVED_PREFIX)
        ? topic.slice(RESOLVED_PREFIX.length)
        : topic

      const found = await findMessageIdInTopic(ctx, stream, resolvedTopic)
      if (!found.ok) return errorResult(found.error)

      const result = await updateMessage(client, found.messageId, {
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
      if (!client) return errorResult(NOT_CONFIGURED)

      // Resolve destination channel name to ID
      const streamsResult = await getStreams(client)
      if (streamsResult.isErr()) return errorResult(formatError(streamsResult.error))

      const destStream = streamsResult.value.streams.find((s) => s.name === toStream)
      if (!destStream) return errorResult(`destination channel "${toStream}" not found`)

      const found = await findMessageIdInTopic(ctx, stream, topic)
      if (!found.ok) return errorResult(found.error)

      const destTopic = toTopic ?? topic
      const result = await updateMessage(client, found.messageId, {
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
