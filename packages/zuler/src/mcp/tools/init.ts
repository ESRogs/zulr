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
      // Try loading .env if credentials aren't already configured
      if (!ctx.isConfigured()) {
        ctx.tryLoadEnv()
      }

      if (!ctx.isConfigured()) {
        return textResult(`# Zuler Setup Required

Zulip credentials are not configured. Two options:

## Option 1: Guided Setup

Spawn the zuler-onboarding agent — it will walk you through creating a Zulip organization (if needed) and configuring credentials.

Tell Claude: "Use the zuler-onboarding agent to help me set up Zulip integration"

## Option 2: Manual Setup

Add a \`.env\` file in your repo root with:

    ZULIP_SITE=https://your-org.zulipchat.com
    ZULIP_EMAIL=your-email@your-org.zulipchat.com
    ZULIP_API_KEY=your-api-key

Then call this tool again to verify. Tools will work immediately, but inbound message delivery requires a restart.`)
      }

      const teammatesResult = await listTeammates(ctx.config.db)
      if (teammatesResult.isErr()) {
        return errorResult(formatError(teammatesResult.error))
      }

      const teammates = teammatesResult.value

      const status =
        teammates.length > 0
          ? `Registered teammates (${teammates.length}):
${teammates.map((t) => `  ${t.name} <${t.botEmail}>`).join('\n')}

Zuler is configured and running. Use the \`post\`, \`read\`, \`subscribe\`, and \`catch-up\` tools to communicate via Zulip.`
          : `Zulip credentials are configured. No teammates registered yet.

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
