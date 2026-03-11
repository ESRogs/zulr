import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { addReaction, removeReaction } from 'zulip-ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerReactTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'react',
    {
      description:
        'Add or remove an emoji reaction on a Zulip message. Use the emoji name without colons (e.g. "thumbs_up", "check", "eyes").',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name (uses their bot identity)'),
        messageId: z.number().describe('Zulip message ID to react to'),
        emoji: z.string().describe('Emoji name (e.g. "thumbs_up", "check", "eyes")'),
        remove: z
          .boolean()
          .optional()
          .default(false)
          .describe('If true, remove the reaction instead of adding it'),
      }),
    },
    async ({ sender, messageId, emoji, remove }) => {
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const fn = remove ? removeReaction : addReaction
      const result = await fn(clientResult.value, messageId, emoji)

      return result.match(
        () => textResult(`${remove ? 'removed' : 'added'} :${emoji}: on message ${messageId}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
