import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Kysely } from 'kysely'
import { z } from 'zod'
import type { GetMessagesParams, ZulipClient } from 'zulip-ts'
import {
  createClient,
  getMessages,
  markAsRead,
  sendDirectMessage,
  sendStreamMessage,
} from 'zulip-ts'
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

type FormattedMessage = {
  readonly id: number
  readonly stream: string
  readonly topic: string
  readonly sender: string
  readonly content: string
  readonly timestamp: number
}

/** Fetch messages and mark them as read. Shared by `read` and `catch-up` tools. */
async function fetchAndMarkRead(
  client: ZulipClient,
  params: GetMessagesParams,
  streamFallback?: string,
  topicFallback?: string,
): Promise<{ messages: FormattedMessage[]; error?: string }> {
  const result = await getMessages(client, params)

  if (result.isErr()) {
    return { messages: [], error: JSON.stringify(result.error) }
  }

  const messages: FormattedMessage[] = result.value.messages.map((msg) => ({
    id: msg.id,
    stream: msg.type === 'stream' ? msg.display_recipient : (streamFallback ?? ''),
    topic: msg.type === 'stream' ? msg.subject : (topicFallback ?? ''),
    sender: msg.sender_full_name,
    content: msg.content,
    timestamp: msg.timestamp,
  }))

  if (messages.length > 0) {
    await markAsRead(
      client,
      messages.map((m) => m.id),
    )
  }

  return { messages }
}

function formatMessages(messages: readonly FormattedMessage[], includeLocation: boolean): string {
  return messages
    .map((msg) => {
      const dt = new Date(msg.timestamp * 1000).toISOString()
      const prefix = includeLocation ? `${msg.stream}/${msg.topic} — ` : ''
      return `[${dt}] ${prefix}${msg.sender}: ${msg.content}`
    })
    .join('\n')
}

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
      // Use bot client if sender provided (for read tracking), otherwise admin
      const readClient = sender
        ? await clientForTeammate(db, zulipSite, sender).match(
            (c) => c,
            () => adminClient,
          )
        : adminClient

      const { messages, error } = await fetchAndMarkRead(readClient, {
        anchor: 'newest',
        numBefore: count,
        numAfter: 0,
        narrow: [
          { operator: 'stream', operand: stream },
          { operator: 'topic', operand: topic },
        ],
        applyMarkdown: false,
      })

      if (error) {
        return { content: [{ type: 'text' as const, text: `error: ${error}` }], isError: true }
      }
      if (messages.length === 0) {
        return { content: [{ type: 'text' as const, text: `(no messages in ${stream}/${topic})` }] }
      }
      return { content: [{ type: 'text' as const, text: formatMessages(messages, false) }] }
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

  // --- catch-up ---
  server.registerTool(
    'catch-up',
    {
      description:
        "Fetch unread messages from all subscribed streams/topics. Uses Zulip's per-bot read tracking, so it returns messages the teammate hasn't seen yet. Marks them as read after fetching. Useful after restart or context compaction.",
      inputSchema: z.object({
        sender: z.string().describe('Teammate name'),
        maxMessages: z
          .number()
          .optional()
          .default(25)
          .describe(
            'Maximum total messages to return (default: 25). Returns the most recent if more are available.',
          ),
      }),
    },
    async ({ sender, maxMessages }) => {
      const teammateResult = await getTeammate(db, sender)
      if (teammateResult.isErr()) {
        return {
          content: [{ type: 'text' as const, text: `error: ${teammateResult.error.message}` }],
          isError: true,
        }
      }

      const teammate = teammateResult.value

      const botClientResult = await clientForTeammate(db, zulipSite, sender)
      if (botClientResult.isErr()) {
        return {
          content: [
            { type: 'text' as const, text: `error: ${JSON.stringify(botClientResult.error)}` },
          ],
          isError: true,
        }
      }
      const botClient = botClientResult.value

      // Collect subscriptions
      const subs: { stream: string; topic?: string }[] = []
      for (const stream of teammate.streamSubs) {
        subs.push({ stream })
      }
      for (const sub of teammate.topicSubs) {
        subs.push({ stream: sub.stream, topic: sub.topic })
      }

      if (subs.length === 0) {
        return { content: [{ type: 'text' as const, text: '(no subscriptions)' }] }
      }

      // Fetch unread messages from each subscription
      const allMessages: FormattedMessage[] = []
      for (const sub of subs) {
        const narrow = [
          { operator: 'stream', operand: sub.stream },
          ...(sub.topic ? [{ operator: 'topic', operand: sub.topic }] : []),
        ]

        const { messages } = await fetchAndMarkRead(
          botClient,
          {
            anchor: 'first_unread',
            numBefore: 0,
            numAfter: maxMessages,
            narrow,
            applyMarkdown: false,
          },
          sub.stream,
          sub.topic,
        )
        allMessages.push(...messages)
      }

      // Sort by timestamp, take most recent maxMessages
      allMessages.sort((a, b) => a.timestamp - b.timestamp)
      const trimmed = allMessages.slice(-maxMessages)

      if (trimmed.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: '(no unread messages across your subscriptions)' },
          ],
        }
      }

      const header =
        allMessages.length > maxMessages
          ? `Showing ${trimmed.length} of ${allMessages.length} unread messages (most recent):\n\n`
          : ''

      return {
        content: [{ type: 'text' as const, text: `${header}${formatMessages(trimmed, true)}` }],
      }
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
