import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { clientForTeammate } from '../../bot-manager.ts'
import { fetchMessages, formatMessages } from '../../zulip/message-reader.ts'
import { errorResult, type ToolContext, textResult } from '../helpers.ts'

export function registerReadTool(server: McpServer, ctx: ToolContext): void {
  const { db, zulipSite } = ctx.config

  server.registerTool(
    'read',
    {
      description:
        'Fetch recent messages from a Zulip stream/topic. If sender is provided, uses their bot API key and marks fetched messages as read.',
      inputSchema: z.object({
        stream: z.string().describe('Stream name'),
        topic: z.string().describe('Topic name'),
        count: z.number().optional().default(10).describe('Number of messages to fetch'),
        sender: z.string().optional().describe('Teammate name (uses their bot for read tracking)'),
      }),
    },
    async ({ stream, topic, count, sender }) => {
      let readClient = ctx.adminClient
      if (sender) {
        const botClientResult = await clientForTeammate(db, zulipSite, sender)
        if (botClientResult.isErr()) {
          return errorResult(`error: ${JSON.stringify(botClientResult.error)}`)
        }
        readClient = botClientResult.value
      }

      return fetchMessages(readClient, {
        anchor: 'newest',
        numBefore: count,
        numAfter: 0,
        narrow: [
          { operator: 'stream', operand: stream },
          { operator: 'topic', operand: topic },
        ],
        applyMarkdown: false,
      }).match(
        (messages) => {
          if (messages.length === 0) {
            return textResult(`(no messages in ${stream}/${topic})`)
          }
          return textResult(formatMessages(messages, false))
        },
        (err) => errorResult(`error: ${JSON.stringify(err)}`),
      )
    },
  )
}
