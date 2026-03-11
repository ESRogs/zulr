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
        'Send a Zulip message. For DMs, provide "to" as a user ID, name, or email. For stream messages, provide "stream" and "topic".',
      inputSchema: z.object({
        sender: z.string().describe('Name of the registered teammate sending the message'),
        content: z.string().describe('Message content'),
        to: z
          .union([z.number(), z.string()])
          .optional()
          .describe('User ID, full name, or email for DMs'),
        stream: z.string().optional().describe('Stream name for stream messages'),
        topic: z.string().optional().describe('Topic for stream messages'),
      }),
    },
    async ({ sender, content, to, stream, topic }) => {
      // Pre-flight unread checks before any async work
      if (stream && topic) {
        const blocked = checkUnreadBeforePost(teamName, sender, stream, topic)
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
            'bots cannot DM other bots. Use a stream/topic for bot-to-bot communication.',
          )
        }

        const result = await sendDirectMessage(clientResult.value, {
          to: [recipient.user_id],
          content,
        })
        return result.match(
          (res) => textResult(`sent DM to ${recipient.full_name} (id: ${res.id})`),
          (err) => errorResult(formatError(err)),
        )
      }

      if (stream && topic) {
        const clientResult = await ctx.getTeammateClient(sender)
        if (clientResult.isErr()) {
          return errorResult(clientResult.error)
        }
        const result = await sendStreamMessage(clientResult.value, { to: stream, topic, content })
        return result.match(
          (res) => textResult(`posted to ${stream}/${topic} (id: ${res.id})`),
          (err) => errorResult(formatError(err)),
        )
      }

      return errorResult('provide either "to" (for DMs) or "stream" and "topic"')
    },
  )
}
