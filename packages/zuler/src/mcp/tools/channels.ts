import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getStreams, getTopics } from 'zulip-ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerChannelsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'channels',
    {
      description: 'List all Zulip channels (streams).',
      inputSchema: z.object({}),
    },
    async () => {
      const client = ctx.getAdminClient()
      if (!client) return errorResult('Zulip credentials not configured. Call the init tool first.')

      const result = await getStreams(client)
      return result.match(
        (res) => {
          if (res.streams.length === 0) return textResult('(no channels)')
          const lines = res.streams
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map((s) => {
              const desc = s.description ? ` — ${s.description}` : ''
              return `${s.name} (id: ${s.stream_id})${desc}`
            })
          return textResult(lines.join('\n'))
        },
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerTopicsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'topics',
    {
      description: 'List topics in a Zulip channel.',
      inputSchema: z.object({
        channel: z.string().describe('Channel name'),
      }),
    },
    async ({ channel }) => {
      const client = ctx.getAdminClient()
      if (!client) return errorResult('Zulip credentials not configured. Call the init tool first.')

      // Resolve channel name to ID
      const streamsResult = await getStreams(client)
      if (streamsResult.isErr()) return errorResult(formatError(streamsResult.error))

      const stream = streamsResult.value.streams.find((s) => s.name === channel)
      if (!stream) return errorResult(`channel "${channel}" not found`)

      const result = await getTopics(client, stream.stream_id)
      return result.match(
        (res) => {
          if (res.topics.length === 0) return textResult(`(no topics in ${channel})`)
          const lines = res.topics.map((t) => t.name)
          return textResult(lines.join('\n'))
        },
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
