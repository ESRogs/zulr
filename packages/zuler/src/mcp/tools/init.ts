import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listTeammates } from '../../state/teammates.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerInitTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'init',
    {
      description:
        'Get started with zuler. Returns setup status and next steps. Call this first when setting up Zulip integration.',
      inputSchema: z.object({}),
    },
    async () => {
      const teammatesResult = await listTeammates(ctx.config.db)
      if (teammatesResult.isErr()) {
        return errorResult(`error: ${formatError(teammatesResult.error)}`)
      }

      const teammates = teammatesResult.value

      const status =
        teammates.length > 0
          ? `Registered teammates (${teammates.length}):
${teammates.map((t) => `  ${t.name} <${t.botEmail}>`).join('\n')}

Zuler is configured and running. Use the \`post\`, \`read\`, \`subscribe\`, and \`catch-up\` tools to communicate via Zulip.`
          : `No teammates registered yet.

## Quick Start

1. **Register a bot** for yourself:
   Call the \`register\` tool with your teammate name.

2. **Subscribe to streams**:
   Call the \`subscribe\` tool to follow Zulip streams/topics.

3. **Post a test message**:
   Call the \`post\` tool to send a message to a Zulip stream.

4. **Check for messages**:
   Call the \`catch-up\` tool to see unread messages.`

      return textResult(`# Zuler Setup Status

${status}

## Guided Setup (Claude Code)

For a guided experience, spawn the zuler-onboarding agent. It will walk you through setup step by step:

  Tell Claude: "Use the zuler-onboarding agent to help me set up Zulip integration"`)
    },
  )
}
