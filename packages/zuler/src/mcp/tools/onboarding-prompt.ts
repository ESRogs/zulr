import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import onboardingMd from '../../../../../.claude/agents/zuler-onboarding.md' with { type: 'text' }
import { type ToolContext, textResult } from '../helpers.ts'

// Strip YAML frontmatter (between --- markers)
const ONBOARDING_PROMPT = onboardingMd.replace(/^---\n[\s\S]*?\n---\n/, '').trim()

export function registerOnboardingPromptTool(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'onboarding-prompt',
    {
      description:
        'Get the zuler onboarding agent prompt. Use this to spawn a teammate that walks through Zulip setup step by step.',
      inputSchema: z.object({}),
    },
    async () => {
      const teamName = ctx.config.teamName
      const hasTeamName = teamName !== 'default'
      const createStep = hasTeamName
        ? `Call TeamCreate with team_name "${teamName}"`
        : 'Call TeamCreate with a team_name matching the project (e.g. the repo name)'
      const spawnTeamName = hasTeamName ? `"${teamName}"` : 'the team name from step 1'

      return textResult(`# How to spawn the zuler onboarding teammate

Follow these steps exactly:

1. **Create a team** (if not already in one): ${createStep}
2. **Spawn the teammate**: Call the Agent tool with:
   - name: "zuler-onboarding"
   - team_name: ${spawnTeamName}
   - prompt: the prompt below (everything after the --- line)

Do NOT spawn this as a subagent. It must be a teammate so it persists throughout setup.

---

${ONBOARDING_PROMPT}`)
    },
  )
}
