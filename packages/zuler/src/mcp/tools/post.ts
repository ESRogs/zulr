import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { sendDirectMessage, sendStreamMessage } from 'zulip-ts'
import { clientForTeammate } from '../../bot-manager.ts'
import { checkUnreadBeforePost } from '../../zulip/unread-check.ts'
import {
  errorResult,
  formatError,
  notConfiguredResult,
  type ToolContext,
  textResult,
} from '../helpers.ts'

export function registerPostTool(server: McpServer, ctx: ToolContext): void {
  const { db, teamName } = ctx.config

  server.registerTool(
    'post',
    {
      description:
        'Send a Zulip message. For DMs, provide "to" as a user ID. For stream messages, provide "stream" and "topic".',
      inputSchema: z.object({
        sender: z.string().describe('Name of the registered teammate sending the message'),
        content: z.string().describe('Message content'),
        to: z.number().optional().describe('User ID for DMs'),
        stream: z.string().optional().describe('Stream name for stream messages'),
        topic: z.string().optional().describe('Topic for stream messages'),
      }),
    },
    async ({ sender, content, to, stream, topic }) => {
      if (stream && topic) {
        const blocked = checkUnreadBeforePost(teamName, sender, stream, topic)
        if (blocked) {
          return errorResult(blocked)
        }
      }

      if (!ctx.isConfigured()) {
        return notConfiguredResult()
      }
      const clientResult = await clientForTeammate(db, ctx.getZulipSite() as string, sender)
      if (clientResult.isErr()) {
        return errorResult(formatError(clientResult.error))
      }
      const senderClient = clientResult.value

      if (to !== undefined) {
        const botCheckResult = await ctx.isBot(to)
        if (botCheckResult.isErr()) {
          return errorResult(formatError(botCheckResult.error))
        }
        if (botCheckResult.value) {
          return errorResult(
            'bots cannot DM other bots. Use a stream/topic for bot-to-bot communication.',
          )
        }
        const result = await sendDirectMessage(senderClient, { to: [to], content })
        return result.match(
          (res) => textResult(`sent DM (id: ${res.id})`),
          (err) => errorResult(formatError(err)),
        )
      }

      if (stream && topic) {
        const result = await sendStreamMessage(senderClient, { to: stream, topic, content })
        return result.match(
          (res) => textResult(`posted to ${stream}/${topic} (id: ${res.id})`),
          (err) => errorResult(formatError(err)),
        )
      }

      return errorResult('provide either "to" (for DMs) or "stream" and "topic"')
    },
  )
}
