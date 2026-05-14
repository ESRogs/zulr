import { z } from 'zod'
import { getTopics, TopicVisibility } from 'zulip-ts'
import {
  errorResult,
  getErrorMessage,
  resolveSender,
  type ToolContext,
  type ToolRegistrar,
  textResult,
  zChannelName,
  zOptionalTeammateName,
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

export function registerTopicStateTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'topic-state',
    {
      description:
        "Query a bot's local state for a channel topic: unread count and visibility (followed, muted, etc.). Uses session state — no API call needed.",
      inputSchema: z.object({
        sender: zOptionalTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
        topic: zTopicName.describe('Topic name'),
      }),
    },
    async ({ sender, channel, topic }) => {
      const senderResult = resolveSender(ctx, sender)
      if (senderResult.isErr()) return errorResult(senderResult.error)
      const manager = ctx.getEventListenerManager()
      const session = manager?.getSession(senderResult.value)

      if (!session) {
        return errorResult(
          `No active session for "${senderResult.value}". The bot may not be registered or the event listener may not be running.`,
        )
      }

      const channelResult = await ctx.cache.resolveChannel(channel)
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

export function registerChannelTopicStatesTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'channel-topic-states',
    {
      description:
        "Query a bot's local state for all topics in a channel: unread counts and visibility. Fetches the topic list from the API, then checks session state for each.",
      inputSchema: z.object({
        sender: zOptionalTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
      }),
    },
    async ({ sender, channel }) => {
      const senderResult = resolveSender(ctx, sender)
      if (senderResult.isErr()) return errorResult(senderResult.error)
      const manager = ctx.getEventListenerManager()
      const session = manager?.getSession(senderResult.value)

      if (!session) {
        return errorResult(
          `No active session for "${senderResult.value}". The bot may not be registered or the event listener may not be running.`,
        )
      }

      const clientResult = await ctx.credentials.getTeammateClient(senderResult.value)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const channelResult = await ctx.cache.resolveChannel(channel)
      if (channelResult.isErr()) return errorResult(channelResult.error)
      const { stream_id: streamId } = channelResult.value

      const topicsResult = await getTopics(clientResult.value.client, streamId)
      if (topicsResult.isErr()) return errorResult(getErrorMessage(topicsResult.error))

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

export function registerFollowedTopicsTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'followed-topics',
    {
      description:
        'List all topics the bot is currently following across all channels. Resolves channel names for topics in unsubscribed channels too (may trigger a `getStreams` API call to populate the 5-min channels cache).',
      inputSchema: z.object({
        sender: zOptionalTeammateName.describe('Teammate name'),
      }),
    },
    async ({ sender }) => {
      const senderResult = resolveSender(ctx, sender)
      if (senderResult.isErr()) return errorResult(senderResult.error)
      const manager = ctx.getEventListenerManager()
      const session = manager?.getSession(senderResult.value)

      if (!session) {
        return errorResult(
          `No active session for "${senderResult.value}". The bot may not be registered or the event listener may not be running.`,
        )
      }

      const followed = session.getFollowedTopics()
      if (followed.length === 0) return textResult('Not following any topics.')

      const channelsMap = await ctx.cache.getChannelsMap().unwrapOr(new Map())

      const grouped = Map.groupBy(followed, (f) => f.streamId)
      const byStream = [...grouped.entries()].map(([streamId, topics]) => {
        const name = channelsMap.get(streamId)?.name ?? `channel ${streamId}`
        return { name, topics: topics.map((t) => t.topic) }
      })

      const lines = [`Following ${followed.length} topic(s):`]
      for (const entry of byStream) {
        for (const topic of entry.topics) {
          lines.push(`  ${entry.name}/${topic}`)
        }
      }

      return textResult(lines.join('\n'))
    },
  )
}
