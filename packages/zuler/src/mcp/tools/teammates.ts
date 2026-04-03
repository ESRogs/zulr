import { z } from 'zod'
import { listTeammates } from '../../state/teammates.ts'
import {
  errorResult,
  formatError,
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
      const result = await listTeammates(ctx.config.db)
      return result.match(
        (list) =>
          textResult(
            list.length === 0
              ? '(no registered teammates)'
              : list.map((t) => `${t.name} <${t.botEmail}>`).join('\n'),
          ),
        (err) => errorResult(formatError(err)),
      )
    },
  )
}
