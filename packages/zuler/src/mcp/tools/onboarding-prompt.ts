import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { errorResult, type ToolContext, textResult } from '../helpers.ts'

/** Lazily load and cache the onboarding agent definition. */
let cachedPrompt: string | null = null

async function getOnboardingPrompt(): Promise<string> {
  if (cachedPrompt) return cachedPrompt
  const mdUrl = new URL('../../../../../.claude/agents/zuler-onboarding.md', import.meta.url)
  const content = await Bun.file(mdUrl).text()
  // Strip YAML frontmatter (between --- markers)
  cachedPrompt = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  return cachedPrompt
}

export function registerOnboardingPromptTool(server: McpServer, _ctx: ToolContext): void {
  server.registerTool(
    'onboarding-prompt',
    {
      description:
        'Get the zuler onboarding agent prompt. Use this to spawn a teammate that walks through Zulip setup step by step.',
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const prompt = await getOnboardingPrompt()
        return textResult(`# How to spawn the zuler onboarding teammate

Follow these steps exactly:

1. **Create a team** (if not already in one): Call TeamCreate with a team_name matching the project (e.g. the repo name)
2. **Spawn the teammate**: Call the Agent tool with:
   - name: "zuler-onboarding"
   - team_name: the team name from step 1
   - prompt: the prompt below (everything after the --- line)

Do NOT spawn this as a subagent. It must be a teammate so it persists throughout setup.

---

${prompt}`)
      } catch {
        return errorResult('Could not load zuler-onboarding.md agent definition.')
      }
    },
  )
}
