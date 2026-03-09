import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listTeammates } from '../../state/teammates.ts'
import { type ToolContext, textResult } from '../helpers.ts'

export function registerInitTool(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx.config

  server.registerTool(
    'init',
    {
      description:
        'Get started with zuler. Returns setup status and next steps. Call this first when setting up Zulip integration.',
      inputSchema: z.object({}),
    },
    async () => {
      const teammatesResult = await listTeammates(db)
      const teammates = teammatesResult.isOk() ? teammatesResult.value : []

      const lines: string[] = ['# Zuler Setup Status', '']

      // Check what's configured
      if (teammates.length > 0) {
        lines.push(`Registered teammates (${teammates.length}):`)
        for (const t of teammates) {
          lines.push(`  ${t.name} <${t.botEmail}>`)
        }
        lines.push('')
        lines.push(
          'Zuler is configured and running. Use the `post`, `read`, `subscribe`, and `catch-up` tools to communicate via Zulip.',
        )
      } else {
        lines.push('No teammates registered yet.', '')
        lines.push('## Quick Start', '')
        lines.push('1. **Register a bot** for yourself:')
        lines.push('   Call the `register` tool with your teammate name.')
        lines.push('')
        lines.push('2. **Subscribe to streams**:')
        lines.push('   Call the `subscribe` tool to follow Zulip streams/topics.')
        lines.push('')
        lines.push('3. **Post a test message**:')
        lines.push('   Call the `post` tool to send a message to a Zulip stream.')
        lines.push('')
        lines.push('4. **Check for messages**:')
        lines.push('   Call the `catch-up` tool to see unread messages.')
      }

      lines.push('')
      lines.push('## Guided Setup (Claude Code)')
      lines.push('')
      lines.push(
        'For a guided experience, spawn the zuler-onboarding agent. It will walk you through setup step by step:',
      )
      lines.push('')
      lines.push(
        '  Tell Claude: "Use the zuler-onboarding agent to help me set up Zulip integration"',
      )

      return textResult(lines.join('\n'))
    },
  )
}
