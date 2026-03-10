import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createToolContext, type ServerConfig } from './helpers.ts'
import { registerCatchUpTool } from './tools/catch-up.ts'
import { registerInitTool } from './tools/init.ts'
import { registerOnboardingPromptTool } from './tools/onboarding-prompt.ts'
import { registerPostTool } from './tools/post.ts'
import { registerReadTool } from './tools/read.ts'
import { registerRegisterTool } from './tools/register.ts'
import {
  registerSubscribeTool,
  registerSubscriptionsTool,
  registerUnsubscribeTool,
} from './tools/subscriptions.ts'
import { registerTeammatesTool } from './tools/teammates.ts'

export type { ServerConfig } from './helpers.ts'

export function createMcpServer(config: ServerConfig) {
  const ctx = createToolContext(config)

  const server = new McpServer({
    name: 'zuler',
    version: '0.1.0',
  })

  registerInitTool(server, ctx)
  registerOnboardingPromptTool(server, ctx)
  registerRegisterTool(server, ctx)
  registerTeammatesTool(server, ctx)
  registerPostTool(server, ctx)
  registerReadTool(server, ctx)
  registerSubscribeTool(server, ctx)
  registerUnsubscribeTool(server, ctx)
  registerSubscriptionsTool(server, ctx)
  registerCatchUpTool(server, ctx)

  return { server, ctx }
}
