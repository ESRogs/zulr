import { z } from 'zod'
import { getSubscriptions } from 'zulip-ts'
import {
  errorResult,
  getErrorMessage,
  resolveSender,
  type ToolContext,
  type ToolRegistrar,
  textResult,
  zOptionalTeammateName,
} from '../helpers.ts'

export function registerSubscriptionsTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'subscriptions',
    {
      description: "List a teammate's current channel subscriptions on Zulip.",
      inputSchema: z.object({
        teammate: zOptionalTeammateName.describe('Teammate name'),
      }),
    },
    async ({ teammate }) => {
      const senderResult = resolveSender(ctx, teammate)
      if (senderResult.isErr()) return errorResult(senderResult.error)
      const clientResult = await ctx.credentials.getTeammateClient(senderResult.value)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const result = await getSubscriptions(clientResult.value.client)
      return result.match(
        (res) => {
          if (res.subscriptions.length === 0) return textResult('(no subscriptions)')
          const lines = res.subscriptions
            .toSorted((a, b) => a.name.localeCompare(b.name))
            .map((s) => `  ${s.name}`)
          return textResult(`channels:\n${lines.join('\n')}`)
        },
        (err) => errorResult(getErrorMessage(err)),
      )
    },
  )
}
