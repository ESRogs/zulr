import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sendDirectMessage, sendStreamMessage } from 'zulip-ts'
import { checkUnreadBeforeDm, checkUnreadBeforePost } from '../../zulip/unread-check.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerPostTool(server: McpServer, ctx: ToolContext): void {
  const { teamName } = ctx.config

  server.registerTool(
    'post',
    {
      description:
        'Send a Zulip message. For DMs, provide "to" as a user ID, name, or email. For channel messages, provide "channel" and "topic". To @-mention a teammate, use @**full name** (e.g. @**scout**) — this auto-subscribes them to the topic. Note: you must read any unread messages in the target topic/DM before posting (use the read or catch-up tool first).',
      inputSchema: z.object({
        sender: z.string().describe('Name of the registered teammate sending the message'),
        content: z.string().describe('Message content'),
        to: z
          .union([z.number(), z.string()])
          .optional()
          .describe('User ID, full name, or email for DMs'),
        channel: z.string().optional().describe('Channel name'),
        topic: z.string().optional().describe('Topic name'),
      }),
    },
    async ({ sender, content, to, channel, topic }) => {
      // Pre-flight unread checks before any async work
      if (channel && topic) {
        const blocked = checkUnreadBeforePost(teamName, sender, channel, topic)
        if (blocked) {
          return errorResult(blocked)
        }
      }

      if (to !== undefined) {
        // Resolve name/email to user ID
        const resolveResult = await ctx.resolveUser(to)
        if (resolveResult.isErr()) {
          return errorResult(resolveResult.error)
        }
        const recipient = resolveResult.value

        const dmBlocked = checkUnreadBeforeDm(teamName, sender, recipient.user_id)
        if (dmBlocked) {
          return errorResult(dmBlocked)
        }

        const clientResult = await ctx.getTeammateClient(sender)
        if (clientResult.isErr()) {
          return errorResult(clientResult.error)
        }

        if (recipient.is_bot) {
          return errorResult(
            'bots cannot DM other bots. Use a channel/topic for bot-to-bot communication.',
          )
        }

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
        const clientResult = await ctx.getTeammateClient(sender)
        if (clientResult.isErr()) {
          return errorResult(clientResult.error)
        }
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
