import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { textResult } from '../helpers.ts'

export function registerRefreshToolListTool(server: McpServer): void {
  server.registerTool(
    'refresh-tool-list',
    {
      description:
        'Ask the server to send a tool list changed notification, causing the client to re-fetch tool schemas. Use this if your tool schemas seem stale after a server restart.',
    },
    () => {
      server.sendToolListChanged()
      return textResult('tool list changed notification sent')
    },
  )
}
