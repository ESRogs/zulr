import { z } from 'zod'
import { addReaction, type MessageId, removeReaction } from 'zulip-ts'
import {
  errorResult,
  getErrorMessage,
  resolveSender,
  type ToolContext,
  type ToolRegistrar,
  textResult,
  zBool,
  zEmojiName,
  zOptionalTeammateName,
} from '../helpers.ts'

export function registerReactTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'react',
    {
      description:
        'Add or remove an emoji reaction on a Zulip message. Use the emoji name without colons (e.g. "thumbs_up", "check", "eyes"). Consider using reactions to acknowledge messages — e.g. "eyes" when you start working on something, "check" when done.',
      inputSchema: z.object({
        sender: zOptionalTeammateName.describe('Teammate name (optional in standalone mode)'),
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
      const resolved = resolveSender(ctx, sender)
      if (!resolved.ok) return errorResult(resolved.error)
      const clientResult = await ctx.credentials.getTeammateClient(resolved.name)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const fn = remove ? removeReaction : addReaction
      const result = await fn(clientResult.value.client, messageId, emoji)

      return result.match(
        () => textResult(`${remove ? 'removed' : 'added'} :${emoji}: on message ${messageId}`),
        (err) => errorResult(getErrorMessage(err)),
      )
    },
  )
}
