import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { archiveStream, createChannel, getTopics, updateChannel } from 'zulip-ts'
import {
  errorResult,
  formatError,
  notConfiguredResult,
  type ToolContext,
  textResult,
  zChannelName,
} from '../helpers.ts'

export function registerCreateChannelTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'create-channel',
    {
      description: 'Create a new Zulip channel.',
      inputSchema: z.object({
        name: zChannelName.describe('Channel name'),
        description: z.string().optional().describe('Channel description'),
      }),
    },
    async ({ name, description }) => {
      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      // Zulip API requires at least one subscriber; use the admin user
      const adminResult = await ctx.resolveUser(client.config.email)
      if (adminResult.isErr()) return errorResult(adminResult.error)

      const result = await createChannel(client, {
        name,
        description,
        subscribers: [adminResult.value.user_id],
      })

      return result.match(
        (res) => {
          ctx.invalidateChannelsCache()
          return textResult(`created channel "${name}" (id: ${res.id})`)
        },
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
        name: zChannelName.optional().describe('New channel name'),
        description: z.string().optional().describe('New channel description'),
      }),
    },
    async ({ channel, name: newName, description }) => {
      if (newName === undefined && description === undefined) {
        return errorResult('provide "name" and/or "description" to update')
      }

      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      const streamResult = await ctx.resolveChannel(channel)
      if (streamResult.isErr()) return errorResult(streamResult.error)

      const result = await updateChannel(client, streamResult.value.stream_id, {
        newName,
        description,
      })

      return result.match(
        () => {
          ctx.invalidateChannelsCache()
          const changes = [
            newName !== undefined ? `renamed to "${newName}"` : '',
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
      const result = await ctx.listChannels()
      return result.match(
        (streams) => {
          if (streams.length === 0) return textResult('(no channels)')
          const lines = [...streams]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((s) => {
              const desc = s.description ? ` — ${s.description}` : ''
              return `${s.name} (id: ${s.stream_id})${desc}`
            })
          return textResult(lines.join('\n'))
        },
        (err) => errorResult(err),
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

      const streamResult = await ctx.resolveChannel(channel)
      if (streamResult.isErr()) return errorResult(streamResult.error)

      const result = await getTopics(client, streamResult.value.stream_id)
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

export function registerArchiveChannelTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'archive-channel',
    {
      description: 'Archive a Zulip channel. This is reversible by an admin in the Zulip UI.',
      inputSchema: z.object({
        channel: z.string().describe('Channel name to archive'),
      }),
    },
    async ({ channel }) => {
      const client = ctx.getAdminClient()
      if (!client) return notConfiguredResult()

      const streamResult = await ctx.resolveChannel(channel)
      if (streamResult.isErr()) return errorResult(streamResult.error)

      const result = await archiveStream(client, streamResult.value.stream_id)
      return result.match(
        () => {
          ctx.invalidateChannelsCache()
          return textResult(`archived channel "${channel}"`)
        },
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
