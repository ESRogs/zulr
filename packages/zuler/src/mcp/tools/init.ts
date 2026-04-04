import { z } from 'zod'
import { listTeammates } from '../../state/teammates.ts'
import {
  errorResult,
  getErrorMessage,
  type ToolContext,
  type ToolRegistrar,
  textResult,
} from '../helpers.ts'

export function registerInitTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'init',
    {
      description:
        'Get started with zuler. Returns setup status and next steps. Call this first when setting up Zulip integration.',
      inputSchema: z.object({}),
    },
    async () => {
      // Try loading .env if credentials aren't already configured
      if (!ctx.credentials.isConfigured()) {
        ctx.credentials.tryLoadEnv()
      }

      if (!ctx.credentials.isConfigured()) {
        return textResult(`# Zuler Setup Required

Zulip credentials are not configured. Ask the user which option they prefer:

1. **Guided setup (recommended)** — spawn a zuler-onboarding teammate that walks through setup step by step. Call the \`onboarding-prompt\` tool to get the agent prompt.
2. **Manual setup** — the user creates a \`.env\` file in the repo root with ZULIP_SITE, ZULIP_EMAIL, and ZULIP_API_KEY, then calls init again to verify.

Present both options to the user and wait for their choice before proceeding.`)
      }

      const teammatesResult = await listTeammates(ctx.config.db)
      if (teammatesResult.isErr()) {
        return errorResult(getErrorMessage(teammatesResult.error))
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

      const guidedSetup =
        teammates.length === 0
          ? `\n\n## Guided Setup (recommended)\n\nFor guided setup, call the \`onboarding-prompt\` tool to get the agent prompt, then spawn a teammate with it.`
          : ''

      return textResult(`# Zuler Setup Status\n\n${status}${guidedSetup}`)
    },
  )
}
