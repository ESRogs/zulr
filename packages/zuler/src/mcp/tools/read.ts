import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { clientForTeammate } from '../../bot-manager.ts'
import { fetchMessages, formatMessages } from '../../zulip/message-reader.ts'
import { errorResult, formatError, type ToolContext, textResult } from '../helpers.ts'

export function registerReadTool(server: McpServer, ctx: ToolContext): void {
  const { db, zulipSite } = ctx.config

  server.registerTool(
    'read',
    {
      description:
        'Fetch recent messages from a Zulip stream/topic. Uses the sender bot API key and marks fetched messages as read.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name (uses their bot for read tracking)'),
        stream: z.string().describe('Stream name'),
        topic: z.string().describe('Topic name'),
        count: z.number().optional().default(10).describe('Number of messages to fetch'),
      }),
    },
    async ({ sender, stream, topic, count }) => {
      const botClientResult = await clientForTeammate(db, zulipSite, sender)
      if (botClientResult.isErr()) {
        return errorResult(`error: ${formatError(botClientResult.error)}`)
      }

      return fetchMessages(
        botClientResult.value,
        {
          anchor: 'newest',
          numBefore: count,
          numAfter: 0,
          narrow: [
            { operator: 'stream', operand: stream },
            { operator: 'topic', operand: topic },
          ],
          applyMarkdown: false,
        },
        { markRead: true },
      ).match(
        (messages) => {
          if (messages.length === 0) {
            return textResult(`(no messages in ${stream}/${topic})`)
          }
          return textResult(formatMessages(messages, false))
        },
        (err) => errorResult(`error: ${formatError(err)}`),
      )
    },
  )
}
