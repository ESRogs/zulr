import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createChannel, getStreams, getTopics, updateChannel } from 'zulip-ts'
import {
  errorResult,
  formatError,
  notConfiguredResult,
  type ToolContext,
  textResult,
} from '../helpers.ts'

export function registerCreateChannelTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'create-channel',
    {
      description: 'Create a new Zulip channel.',
      inputSchema: z.object({
        name: z.string().describe('Channel name'),
        description: z.string().optional().describe('Channel description'),
      }),
    },
    async ({ name, description }) => {
      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      // Resolve admin user ID for the subscribers list
      const adminResult = await ctx.resolveUser(client.config.email)
      if (adminResult.isErr()) return errorResult(adminResult.error)

      const result = await createChannel(client, {
        name,
        description,
        subscribers: [adminResult.value.user_id],
      })

      return result.match(
        (res) => textResult(`created channel "${name}" (id: ${res.id})`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerEditChannelTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'edit-channel',
    {
      description: 'Rename a Zulip channel or update its description.',
      inputSchema: z.object({
        channel: z.string().describe('Current channel name'),
        name: z.string().optional().describe('New channel name'),
        description: z.string().optional().describe('New channel description'),
      }),
    },
    async ({ channel, name, description }) => {
      if (name === undefined && description === undefined) {
        return errorResult('provide "name" and/or "description" to update')
      }

      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      const streamsResult = await getStreams(client)
      if (streamsResult.isErr()) return errorResult(formatError(streamsResult.error))

      const stream = streamsResult.value.streams.find((s) => s.name === channel)
      if (!stream) return errorResult(`channel "${channel}" not found`)

      const result = await updateChannel(client, stream.stream_id, {
        newName: name,
        description,
      })

      return result.match(
        () => {
          const changes = [
            name ? `renamed to "${name}"` : '',
            description !== undefined ? 'description updated' : '',
          ]
            .filter(Boolean)
            .join(', ')
          return textResult(`${channel}: ${changes}`)
        },
        (err) => errorResult(formatError(err)),
      )
    },
  )
}

export function registerChannelsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'channels',
    {
      description: 'List all Zulip channels.',
      inputSchema: z.object({}),
    },
    async () => {
      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

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
      if (!client) return notConfiguredResult()

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
