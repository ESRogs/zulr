import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { addReaction, type EmojiName, type MessageId, removeReaction } from 'zulip-ts'
import type { TeammateName } from '../../tagged-types.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerReactTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'react',
    {
      description:
        'Add or remove an emoji reaction on a Zulip message. Use the emoji name without colons (e.g. "thumbs_up", "check", "eyes"). Consider using reactions to acknowledge messages — e.g. "eyes" when you start working on something, "check" when done.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name (uses their bot identity)'),
        messageId: z.coerce
          .number()
          .transform((n): MessageId => n as MessageId)
          .describe('Zulip message ID to react to'),
        emoji: z.string().describe('Emoji name (e.g. "thumbs_up", "check", "eyes")'),
        remove: z
          .union([z.boolean(), z.string().transform((s) => s === 'true')])
          .optional()
          .default(false)
          .describe('If true, remove the reaction instead of adding it'),
      }),
    },
    async ({ sender: rawSender, messageId, emoji: rawEmoji, remove }) => {
      const sender = rawSender as TeammateName
      const emoji = rawEmoji as EmojiName
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const fn = remove ? removeReaction : addReaction
      const result = await fn(clientResult.value.client, messageId, emoji)

      return result.match(
        () => textResult(`${remove ? 'removed' : 'added'} :${emoji}: on message ${messageId}`),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
