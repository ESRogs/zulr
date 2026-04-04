import { z } from 'zod'
import { addReaction, type MessageId, removeReaction } from 'zulip-ts'
import {
  errorResult,
  formatError,
  type ToolContext,
  type ToolRegistrar,
  textResult,
  zBool,
  zEmojiName,
  zTeammateName,
} from '../helpers.ts'

export function registerReactTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'react',
    {
      description:
        'Add or remove an emoji reaction on a Zulip message. Use the emoji name without colons (e.g. "thumbs_up", "check", "eyes"). Consider using reactions to acknowledge messages — e.g. "eyes" when you start working on something, "check" when done.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name (uses their bot identity)'),
        messageId: z.coerce
          .number()
          .transform((n): MessageId => n as MessageId)
          .describe('Zulip message ID to react to'),
        emoji: zEmojiName.describe('Emoji name (e.g. "thumbs_up", "check", "eyes")'),
        remove: zBool
          .optional()
          .default(false)
          .describe('If true, remove the reaction instead of adding it'),
      }),
    },
    async ({ sender, messageId, emoji, remove }) => {
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
