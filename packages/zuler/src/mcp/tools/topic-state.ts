import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  errorResult,
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
      const visibilityLabel = VISIBILITY_LABELS[visibility] ?? `unknown (${visibility})`
      const followed = session.isFollowed(streamId, topic)

      const lines = [
        `${channel}/${topic}`,
        `  Unread: ${unreadCount} message(s)`,
        `  Visibility: ${visibilityLabel}`,
        `  Following: ${followed ? 'yes' : 'no'}`,
      ]

      return textResult(lines.join('\n'))
    },
  )
}
