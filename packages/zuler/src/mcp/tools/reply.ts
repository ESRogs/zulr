import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sendDirectMessage, sendStreamMessage } from 'zulip-ts'
import {
  errorResult,
  formatError,
  type ToolContext,
  textResult,
  zChannelName,
  zTeammateName,
  zTopicName,
} from '../helpers.ts'

export function registerReplyTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'reply',
    {
      description:
        'Send a Zulip message after checking for unread messages. If there are unreads in the target topic or DM, returns an error asking you to catch up first. Use "post" instead to skip this check (e.g. for new threads or when accumulated unreads aren\'t relevant).',
      inputSchema: z.object({
        sender: zTeammateName.describe('Name of the registered teammate sending the message'),
        content: z.string().describe('Message content'),
        to: z
          .union([z.number(), z.string()])
          .optional()
          .describe('User ID, full name, or email for DMs'),
        channel: zChannelName.optional().describe('Channel name'),
        topic: zTopicName.optional().describe('Topic name'),
      }),
    },
    async ({ sender, content, to, channel, topic }) => {
      const manager = ctx.getEventListenerManager()
      const session = manager?.getSession(sender)

      if (to !== undefined) {
        const resolveResult = await ctx.resolveUser(to)
        if (resolveResult.isErr()) return errorResult(resolveResult.error)
        const recipient = resolveResult.value

        if (recipient.is_bot) {
          return errorResult(
            'bots cannot DM other bots. Use a channel/topic for bot-to-bot communication.',
          )
        }

        // Session-based unread check for DMs
        if (session?.hasUnreadDms(recipient.user_id)) {
          const count = session.getUnreadDmCount(recipient.user_id)
          return errorResult(
            `You have ${count} unread DM(s) from ${recipient.full_name}. Use read or catch-up to catch up first, or use post to skip this check.`,
          )
        }

        const clientResult = await ctx.getTeammateClient(sender)
        if (clientResult.isErr()) return errorResult(clientResult.error)

        const result = await sendDirectMessage(clientResult.value.client, {
          to: [recipient.user_id],
          content,
        })
        return result.match(
          (res) => textResult(`sent DM to ${recipient.full_name} (id: ${res.id})`),
          (err) => errorResult(formatError(err)),
        )
      }

      if (channel && topic) {
        // Resolve channel name → stream ID for session query
        const channelResult = await ctx.resolveChannel(channel)
        if (channelResult.isErr()) return errorResult(channelResult.error)
        const { stream_id: streamId } = channelResult.value

        if (session?.hasUnreads(streamId, topic)) {
          const count = session.getUnreadCount(streamId, topic)
          return errorResult(
            `You have ${count} unread message(s) in ${channel}/${topic}. Use read or catch-up to catch up first, or use post to skip this check.`,
          )
        }

        const clientResult = await ctx.getTeammateClient(sender)
        if (clientResult.isErr()) return errorResult(clientResult.error)

        const result = await sendStreamMessage(clientResult.value.client, {
          to: channel,
          topic,
          content,
        })
        return result.match(
          (res) => textResult(`posted to ${channel}/${topic} (id: ${res.id})`),
          (err) => errorResult(formatError(err)),
        )
      }

      return errorResult('provide either "to" (for DMs) or "channel" and "topic"')
    },
  )
}
