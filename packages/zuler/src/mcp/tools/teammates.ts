import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listTeammates } from '../../state/teammates.ts'
import { errorResult, type ToolContext, textResult } from '../helpers.ts'

export function registerTeammatesTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
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
        (err) => errorResult(`error: ${err.message}`),
      )
    },
  )
}
