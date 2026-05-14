import { z } from 'zod'
import { listTeammates } from '../../state/teammates.ts'
import {
  errorResult,
  getErrorMessage,
  type ToolContext,
  type ToolRegistrar,
  textResult,
} from '../helpers.ts'

export function registerTeammatesTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'teammates',
    {
      description: 'List all registered teammates.',
      inputSchema: z.object({}),
    },
    async () => {
      if (ctx.config.agentName) {
        return textResult(`${ctx.config.agentName} (standalone mode)`)
      }

      const result = await listTeammates(ctx.config.db)
      return result.match(
        (list) =>
          textResult(
            list.length === 0
              ? '(no registered teammates)'
              : list.map((t) => `${t.name} <${t.botEmail}>`).join('\n'),
          ),
        (err) => errorResult(getErrorMessage(err)),
      )
    },
  )
}
