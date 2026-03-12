import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createToolContext, type ServerConfig } from './helpers.ts'
import { registerCatchUpTool } from './tools/catch-up.ts'
import {
  registerArchiveChannelTool,
  registerChannelsTool,
  registerCreateChannelTool,
  registerEditChannelTool,
  registerSubscribersTool,
  registerTopicsTool,
} from './tools/channels.ts'
import { registerInitTool } from './tools/init.ts'
import { registerOnboardingPromptTool } from './tools/onboarding-prompt.ts'
import { registerPostTool } from './tools/post.ts'
import { registerReactTool } from './tools/reactions.ts'
import { registerReadTool } from './tools/read.ts'
import { registerRegisterTool } from './tools/register.ts'
import { registerSearchTool } from './tools/search.ts'
import {
  registerSubscribeTool,
  registerSubscriptionsTool,
  registerUnsubscribeTool,
} from './tools/subscriptions.ts'
import { registerTeammatesTool } from './tools/teammates.ts'
import {
  registerMoveTopicTool,
  registerResolveTopicTool,
  registerUnresolveTopicTool,
} from './tools/topic-actions.ts'
import { registerDownloadTool, registerUploadTool } from './tools/files.ts'

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
  registerReactTool(server, ctx)
  registerReadTool(server, ctx)
  registerSearchTool(server, ctx)
  registerSubscribeTool(server, ctx)
  registerUnsubscribeTool(server, ctx)
  registerSubscriptionsTool(server, ctx)
  registerCatchUpTool(server, ctx)
  registerCreateChannelTool(server, ctx)
  registerEditChannelTool(server, ctx)
  registerArchiveChannelTool(server, ctx)
  registerChannelsTool(server, ctx)
  registerSubscribersTool(server, ctx)
  registerTopicsTool(server, ctx)
  registerResolveTopicTool(server, ctx)
  registerUnresolveTopicTool(server, ctx)
  registerMoveTopicTool(server, ctx)
  registerUploadTool(server, ctx)
  registerDownloadTool(server, ctx)

  return { server, ctx }
}
