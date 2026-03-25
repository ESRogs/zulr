import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getTopics, TopicVisibility } from 'zulip-ts'
import {
  errorResult,
  formatError,
  type ToolContext,
  textResult,
  zChannelName,
  zTeammateName,
  zTopicName,
} from '../helpers.ts'

const VISIBILITY_LABELS: Record<number, string> = {
  0: 'inherit (default)',
  1: 'muted',
  2: 'unmuted',
  3: 'followed',
}

function visibilityLabel(policy: number): string {
  return VISIBILITY_LABELS[policy] ?? `unknown (${policy})`
}

export function registerTopicStateTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'topic-state',
    {
      description:
        "Query a bot's local state for a channel topic: unread count and visibility (followed, muted, etc.). Uses session state — no API call needed.",
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name (queries their session state)'),
        channel: zChannelName.describe('Channel name'),
        topic: zTopicName.describe('Topic name'),
      }),
    },
    async ({ sender, channel, topic }) => {
      const manager = ctx.getEventListenerManager()
      const session = manager?.getSession(sender)

      if (!session) {
        return errorResult(
          `No active session for "${sender}". The bot may not be registered or the event listener may not be running.`,
        )
      }

      const channelResult = await ctx.resolveChannel(channel)
      if (channelResult.isErr()) return errorResult(channelResult.error)
      const { stream_id: streamId } = channelResult.value

      const unreadCount = session.getUnreadCount(streamId, topic)
      const visibility = session.getTopicVisibility(streamId, topic)
      const followed = session.isFollowed(streamId, topic)

      const lines = [
        `${channel}/${topic}`,
        `  Unread: ${unreadCount} message(s)`,
        `  Visibility: ${visibilityLabel(visibility)}`,
        `  Following: ${followed ? 'yes' : 'no'}`,
      ]

      return textResult(lines.join('\n'))
    },
  )
}

export function registerChannelTopicStatesTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'channel-topic-states',
    {
      description:
        "Query a bot's local state for all topics in a channel: unread counts and visibility. Fetches the topic list from the API, then checks session state for each.",
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
      }),
    },
    async ({ sender, channel }) => {
      const manager = ctx.getEventListenerManager()
      const session = manager?.getSession(sender)

      if (!session) {
        return errorResult(
          `No active session for "${sender}". The bot may not be registered or the event listener may not be running.`,
        )
      }

      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const channelResult = await ctx.resolveChannel(channel)
      if (channelResult.isErr()) return errorResult(channelResult.error)
      const { stream_id: streamId } = channelResult.value

      const topicsResult = await getTopics(clientResult.value.client, streamId)
      if (topicsResult.isErr()) return errorResult(formatError(topicsResult.error))

      const topics = topicsResult.value.topics
      if (topics.length === 0) return textResult(`${channel}: no topics`)

      const lines = [`${channel} (${topics.length} topics):`]
      for (const t of topics) {
        const unread = session.getUnreadCount(streamId, t.name)
        const vis = session.getTopicVisibility(streamId, t.name)
        const flags: string[] = []
        if (vis === TopicVisibility.FOLLOWED) flags.push('followed')
        else if (vis === TopicVisibility.MUTED) flags.push('muted')
        else if (vis === TopicVisibility.UNMUTED) flags.push('unmuted')
        if (unread > 0) flags.push(`${unread} unread`)
        const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : ''
        lines.push(`  ${t.name}${suffix}`)
      }

      return textResult(lines.join('\n'))
    },
  )
}

export function registerFollowedTopicsTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'followed-topics',
    {
      description:
        'List all topics the bot is currently following across all channels. Uses session state — no API call needed.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
      }),
    },
    async ({ sender }) => {
      const manager = ctx.getEventListenerManager()
      const session = manager?.getSession(sender)

      if (!session) {
        return errorResult(
          `No active session for "${sender}". The bot may not be registered or the event listener may not be running.`,
        )
      }

      const followed = session.getFollowedTopics()
      if (followed.length === 0) return textResult('Not following any topics.')

      // Group by stream, resolve channel names
      const byStream = new Map<number, { name: string; topics: string[] }>()
      for (const f of followed) {
        let entry = byStream.get(f.streamId)
        if (!entry) {
          const sub = session.getSubscription(f.streamId)
          const name = sub?.name ?? `stream ${f.streamId}`
          entry = { name, topics: [] }
          byStream.set(f.streamId, entry)
        }
        entry.topics.push(f.topic)
      }

      const lines = [`Following ${followed.length} topic(s):`]
      for (const entry of byStream.values()) {
        for (const topic of entry.topics) {
          lines.push(`  ${entry.name}/${topic}`)
        }
      }

      return textResult(lines.join('\n'))
    },
  )
}
