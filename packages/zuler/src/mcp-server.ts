import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import { createClient, getMessages, sendDirectMessage, sendStreamMessage } from 'zulip-ts'
import { clientForTeammate, registerBot } from './bot-manager.ts'
import type { ZulerDatabase } from './db.ts'
import { startEventListener } from './event-listener.ts'
import {
  addStreamSubscription,
  addTopicSubscription,
  getTeammate,
  listTeammates,
  removeAllStreamSubscriptions,
  removeStreamSubscription,
  removeTopicSubscription,
} from './state.ts'
import { checkUnreadBeforePost } from './unread-check.ts'

type ServerConfig = {
  readonly db: Kysely<ZulerDatabase>
  readonly zulipSite: string
  readonly zulipEmail: string
  readonly zulipApiKey: string
  readonly teamName: string
}

export function createMcpServer(config: ServerConfig) {
  const { db, zulipSite, zulipEmail, zulipApiKey, teamName } = config
  const adminClient = createClient({ site: zulipSite, email: zulipEmail, apiKey: zulipApiKey })

  const server = new McpServer({
    name: 'zuler',
    version: '0.1.0',
  })

  // --- register ---
  server.registerTool(
    'register',
    {
      description: 'Register a teammate: create or look up a Zulip bot and store credentials.',
      inputSchema: z.object({
        name: z.string().describe('Teammate name'),
      }),
    },
    async ({ name }) => {
      const result = await registerBot(adminClient, db, name)
      return result.match(
        (info) => ({
          content: [{ type: 'text' as const, text: `registered '${name}' (${info.botEmail})` }],
        }),
        (err) => ({
          content: [{ type: 'text' as const, text: `error: ${JSON.stringify(err)}` }],
          isError: true,
        }),
      )
    },
  )

  // --- teammates ---
  server.registerTool(
    'teammates',
    {
      description: 'List all registered teammates.',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await listTeammates(db)
      return result.match(
        (list) => ({
          content: [
            {
              type: 'text' as const,
              text:
                list.length === 0
                  ? '(no registered teammates)'
                  : list.map((t) => `${t.name} <${t.botEmail}>`).join('\n'),
            },
          ],
        }),
        (err) => ({
          content: [{ type: 'text' as const, text: `error: ${err.message}` }],
          isError: true,
        }),
      )
    },
  )

  // --- post ---
  server.registerTool(
    'post',
    {
      description:
        'Send a Zulip message. For DMs, provide "to" as a user ID. For stream messages, provide "stream" and "topic".',
      inputSchema: z.object({
        sender: z.string().describe('Name of the registered teammate sending the message'),
        content: z.string().describe('Message content'),
        to: z.number().optional().describe('User ID for DMs'),
        stream: z.string().optional().describe('Stream name for stream messages'),
        topic: z.string().optional().describe('Topic for stream messages'),
      }),
    },
    async ({ sender, content, to, stream, topic }) => {
      if (stream && topic) {
        const blocked = checkUnreadBeforePost(teamName, sender, stream, topic)
        if (blocked) {
          return {
            content: [{ type: 'text' as const, text: blocked }],
            isError: true,
          }
        }
      }

      const clientResult = await clientForTeammate(db, zulipSite, sender)
      if (clientResult.isErr()) {
        return {
          content: [
            { type: 'text' as const, text: `error: ${JSON.stringify(clientResult.error)}` },
          ],
          isError: true,
        }
      }
      const senderClient = clientResult.value

      if (to !== undefined) {
        const result = await sendDirectMessage(senderClient, { to: [to], content })
        return result.match(
          () => ({
            content: [
              { type: 'text' as const, text: `sent DM (id: ${result._unsafeUnwrap().id})` },
            ],
          }),
          (err) => ({
            content: [{ type: 'text' as const, text: `error: ${JSON.stringify(err)}` }],
            isError: true,
          }),
        )
      }

      if (stream && topic) {
        const result = await sendStreamMessage(senderClient, { to: stream, topic, content })
        return result.match(
          (res) => ({
            content: [
              { type: 'text' as const, text: `posted to ${stream}/${topic} (id: ${res.id})` },
            ],
          }),
          (err) => ({
            content: [{ type: 'text' as const, text: `error: ${JSON.stringify(err)}` }],
            isError: true,
          }),
        )
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: 'error: provide either "to" (for DMs) or "stream" and "topic"',
          },
        ],
        isError: true,
      }
    },
  )

  // --- read ---
  server.registerTool(
    'read',
    {
      description: 'Fetch recent messages from a Zulip stream/topic.',
      inputSchema: z.object({
        stream: z.string().describe('Stream name'),
        topic: z.string().describe('Topic name'),
        count: z.number().optional().default(10).describe('Number of messages to fetch'),
      }),
    },
    async ({ stream, topic, count }) => {
      const result = await getMessages(adminClient, {
        anchor: 'newest',
        numBefore: count,
        numAfter: 0,
        narrow: [
          { operator: 'stream', operand: stream },
          { operator: 'topic', operand: topic },
        ],
        applyMarkdown: false,
      })

      return result.match(
        (res) => {
          if (res.messages.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `(no messages in ${stream}/${topic})` }],
            }
          }
          const lines = res.messages.map((msg) => {
            const dt = new Date(msg.timestamp * 1000).toISOString()
            return `[${dt}] ${msg.sender_full_name}: ${msg.content}`
          })
          return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
        },
        (err) => ({
          content: [{ type: 'text' as const, text: `error: ${JSON.stringify(err)}` }],
          isError: true,
        }),
      )
    },
  )

  // --- subscribe ---
  server.registerTool(
    'subscribe',
    {
      description: 'Subscribe a teammate to a stream or a specific stream/topic.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        stream: z.string().describe('Stream name'),
        topic: z.string().optional().describe('Topic name (omit for whole-stream subscription)'),
      }),
    },
    async ({ sender, stream, topic }) => {
      const result = topic
        ? await addTopicSubscription(db, sender, stream, topic)
        : await addStreamSubscription(db, sender, stream)

      return result.match(
        () => ({
          content: [
            {
              type: 'text' as const,
              text: `subscribed to ${topic ? `${stream}/${topic}` : stream}`,
            },
          ],
        }),
        (err) => ({
          content: [{ type: 'text' as const, text: `error: ${err.message}` }],
          isError: true,
        }),
      )
    },
  )

  // --- unsubscribe ---
  server.registerTool(
    'unsubscribe',
    {
      description:
        'Unsubscribe a teammate from a stream, a specific topic, or all subscriptions in a stream.',
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        stream: z.string().describe('Stream name'),
        topic: z.string().optional().describe('Topic name (omit for stream-level unsubscribe)'),
        all: z
          .boolean()
          .optional()
          .default(false)
          .describe('Remove stream and all topic subscriptions'),
      }),
    },
    async ({ sender, stream, topic, all }) => {
      const result = all
        ? await removeAllStreamSubscriptions(db, sender, stream)
        : topic
          ? await removeTopicSubscription(db, sender, stream, topic)
          : await removeStreamSubscription(db, sender, stream)

      const target = all ? `${stream} (all)` : topic ? `${stream}/${topic}` : stream
      return result.match(
        () => ({ content: [{ type: 'text' as const, text: `unsubscribed from ${target}` }] }),
        (err) => ({
          content: [{ type: 'text' as const, text: `error: ${err.message}` }],
          isError: true,
        }),
      )
    },
  )

  // --- subscriptions ---
  server.registerTool(
    'subscriptions',
    {
      description: "List a teammate's current stream and topic subscriptions.",
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
      }),
    },
    async ({ sender }) => {
      const result = await getTeammate(db, sender)
      return result.match(
        (t) => {
          const lines: string[] = []
          if (t.streamSubs.length > 0) {
            lines.push('streams:')
            for (const s of t.streamSubs) lines.push(`  ${s}`)
          }
          if (t.topicSubs.length > 0) {
            lines.push('topics:')
            for (const sub of t.topicSubs) lines.push(`  ${sub.stream}/${sub.topic}`)
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: lines.length === 0 ? '(no subscriptions)' : lines.join('\n'),
              },
            ],
          }
        },
        (err) => ({
          content: [{ type: 'text' as const, text: `error: ${err.message}` }],
          isError: true,
        }),
      )
    },
  )

  return server
}

/** Start the MCP server with stdio transport and background event listener. */
export async function startServer(config: ServerConfig): Promise<void> {
  const server = createMcpServer(config)
  const adminClient = createClient({
    site: config.zulipSite,
    email: config.zulipEmail,
    apiKey: config.zulipApiKey,
  })

  const abortController = new AbortController()

  // Start event listener in background
  startEventListener({
    client: adminClient,
    db: config.db,
    teamName: config.teamName,
    signal: abortController.signal,
    onRoute: (info) => {
      const location = info.stream ? `${info.stream}/${info.topic}` : 'DM'
      console.error(`[zuler] ${location} from ${info.sender} → ${info.deliveredTo.join(', ')}`)
    },
    onError: (err) => {
      console.error('[zuler] event listener error:', err)
    },
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
