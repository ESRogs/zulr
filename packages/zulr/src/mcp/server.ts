import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createToolContext, createToolRegistrar, type ServerConfig } from './helpers.ts'
import { registerCatchUpTool } from './tools/catch-up.ts'
import {
  registerArchiveChannelTool,
  registerChannelsTool,
  registerCreateChannelTool,
  registerEditChannelTool,
  registerTopicsTool,
} from './tools/channels.ts'
import { registerDownloadTool, registerUploadTool } from './tools/files.ts'
import { registerInitTool } from './tools/init.ts'
import { registerOnboardingPromptTool } from './tools/onboarding-prompt.ts'
import { registerPostTool } from './tools/post.ts'
import { registerReactTool } from './tools/reactions.ts'
import { registerReadTool } from './tools/read.ts'
import { registerRegisterTool } from './tools/register.ts'

import { registerSearchTool } from './tools/search.ts'
import { registerSubscriptionsTool } from './tools/subscriptions.ts'
import { registerTeammatesTool } from './tools/teammates.ts'
import {
  registerMoveTopicTool,
  registerResolveTopicTool,
  registerUnresolveTopicTool,
} from './tools/topic-actions.ts'
import {
  registerFollowTool,
  registerMuteTool,
  registerUnfollowTool,
  registerUnmuteTool,
} from './tools/topic-follow.ts'
import {
  registerChannelTopicStatesTool,
  registerFollowedTopicsTool,
  registerTopicStateTool,
} from './tools/topic-state.ts'

export type { ServerConfig } from './helpers.ts'

export function createMcpServer(config: ServerConfig) {
  const ctx = createToolContext(config)

  const server = new McpServer({
    name: 'zulr',
    version: '0.1.0',
  })

  const registrar = createToolRegistrar(server, ctx)

  registerInitTool(registrar, ctx)
  registerOnboardingPromptTool(registrar, ctx)
  registerRegisterTool(registrar, ctx)
  registerTeammatesTool(registrar, ctx)
  registerPostTool(registrar, ctx)

  registerReactTool(registrar, ctx)
  registerReadTool(registrar, ctx)
  registerSearchTool(registrar, ctx)
  registerSubscriptionsTool(registrar, ctx)
  registerCatchUpTool(registrar, ctx)
  registerCreateChannelTool(registrar, ctx)
  registerEditChannelTool(registrar, ctx)
  registerArchiveChannelTool(registrar, ctx)
  registerChannelsTool(registrar, ctx)
  registerTopicsTool(registrar, ctx)
  registerResolveTopicTool(registrar, ctx)
  registerUnresolveTopicTool(registrar, ctx)
  registerMoveTopicTool(registrar, ctx)
  registerFollowTool(registrar, ctx)
  registerUnfollowTool(registrar, ctx)
  registerMuteTool(registrar, ctx)
  registerUnmuteTool(registrar, ctx)
  registerTopicStateTool(registrar, ctx)
  registerChannelTopicStatesTool(registrar, ctx)
  registerFollowedTopicsTool(registrar, ctx)
  registerUploadTool(registrar, ctx)
  registerDownloadTool(registrar, ctx)

  return { server, ctx }
}
