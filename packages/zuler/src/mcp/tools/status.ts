import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { updateStatus } from 'zulip-ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerStatusTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'set-status',
    {
      description:
        'Set a teammate\'s Zulip status message and optional emoji. Pass empty statusText to clear.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        statusText: z.string().describe('Status text (max 60 chars). Empty string clears status.'),
        emoji: z.string().optional().describe('Emoji name (e.g. "working_on_it", "calendar")'),
      }),
    },
    async ({ sender, statusText, emoji }) => {
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const result = await updateStatus(clientResult.value, {
        statusText,
        emojiName: emoji,
      })

      return result.match(
        () =>
          statusText
            ? textResult(`status set: ${emoji ? `:${emoji}: ` : ''}${statusText}`)
            : textResult('status cleared'),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
