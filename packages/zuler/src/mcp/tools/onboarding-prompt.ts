import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type ToolContext, textResult } from '../helpers.ts'

/** Read the onboarding agent definition, stripping YAML frontmatter. */
function loadOnboardingPrompt(): string {
  const mdPath = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    '.claude',
    'agents',
    'zuler-onboarding.md',
  )
  try {
    const content = readFileSync(mdPath, 'utf-8')
    // Strip YAML frontmatter (between --- markers)
    return content.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
  } catch {
    return 'Error: could not load zuler-onboarding.md agent definition.'
  }
}

const ONBOARDING_PROMPT = loadOnboardingPrompt()

export function registerOnboardingPromptTool(server: McpServer, _ctx: ToolContext): void {
  server.registerTool(
    'onboarding-prompt',
    {
      description:
        'Get the zuler onboarding agent prompt. Use this to spawn a teammate that walks through Zulip setup step by step.',
      inputSchema: z.object({}),
    },
    async () => {
      return textResult(`# How to spawn the zuler onboarding teammate

Follow these steps exactly:

1. **Create a team** (if not already in one): Call TeamCreate with a team_name matching the project (e.g. the repo name)
2. **Spawn the teammate**: Call the Agent tool with:
   - name: "zuler-onboarding"
   - team_name: the team name from step 1
   - prompt: the prompt below (everything after the --- line)

Do NOT spawn this as a subagent. It must be a teammate so it persists throughout setup.

---

${ONBOARDING_PROMPT}`)
    },
  )
}
