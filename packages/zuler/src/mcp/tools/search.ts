import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { TeammateName } from '../../tagged-types.ts'
import { fetchMessages, formatMessages } from '../../zulip/message-reader.ts'
import {
  buildUserIdResolver,
  errorResult,
  formatError,
  type ToolContext,
  textResult,
} from '../helpers.ts'

export function registerSearchTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search',
    {
      description:
        'Search Zulip messages by keyword. Optionally scope to a channel and/or topic. Consider searching before asking questions that might already be answered in the history.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name (uses their bot for search)'),
        query: z.string().describe('Search query'),
        channel: z.string().optional().describe('Limit search to this channel'),
        topic: z.string().optional().describe('Limit search to this topic (requires channel)'),
        count: z.coerce.number().optional().default(20).describe('Max results (default: 20)'),
      }),
    },
    async ({ sender: rawSender, query, channel, topic, count }) => {
      if (topic && !channel) {
        return errorResult('"topic" requires "channel" to be specified')
      }

      const clientResult = await ctx.getTeammateClient(rawSender as TeammateName)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const { client, botUserId } = clientResult.value

      const resolveUserId = await buildUserIdResolver(ctx)

      const narrow = [
        { operator: 'search', operand: query },
        ...(channel ? [{ operator: 'stream', operand: channel }] : []),
        ...(channel && topic ? [{ operator: 'topic', operand: topic }] : []),
      ]

      const result = await fetchMessages(
        client,
        {
          anchor: 'newest',
          numBefore: count,
          numAfter: 0,
          narrow,
          applyMarkdown: false,
        },
        { markRead: false, botUserId, resolveUserId },
      )

      if (result.isErr()) return errorResult(formatError(result.error))

      const messages = result.value
      if (messages.length === 0) return textResult('(no results)')

      const sorted = messages.toSorted((a, b) => a.timestamp - b.timestamp)
      return textResult(`${sorted.length} result(s):\n\n${formatMessages(sorted, true)}`)
    },
  )
}
