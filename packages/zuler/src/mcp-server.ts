import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Kysely } from 'kysely'
import { okAsync, type ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { GetMessagesParams, ZulipClient, ZulipError } from 'zulip-ts'
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

/** Fetch messages, optionally marking them as read. Shared by `read` and `catch-up` tools. */
function fetchMessages(
  client: ZulipClient,
  params: GetMessagesParams,
  options?: { markRead?: boolean; streamFallback?: string; topicFallback?: string },
): ResultAsync<readonly FormattedMessage[], ZulipError> {
  const { markRead = true, streamFallback, topicFallback } = options ?? {}

  return getMessages(client, params).andThen((res) => {
    const messages: FormattedMessage[] = res.messages.map((msg) => ({
      id: msg.id,
      stream: msg.type === 'stream' ? msg.display_recipient : (streamFallback ?? ''),
      topic: msg.type === 'stream' ? msg.subject : (topicFallback ?? ''),
      sender: msg.sender_full_name,
      content: msg.content,
      timestamp: msg.timestamp,
    }))

    if (markRead && messages.length > 0) {
      return markAsRead(
        client,
        messages.map((m) => m.id),
      ).map(() => messages)
    }

    return okAsync(messages)
  })
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

/** MCP tool response helpers */
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
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
        (info) => textResult(`registered '${name}' (${info.botEmail})`),
        (err) => errorResult(`error: ${JSON.stringify(err)}`),
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
        (list) =>
          textResult(
            list.length === 0
              ? '(no registered teammates)'
              : list.map((t) => `${t.name} <${t.botEmail}>`).join('\n'),
          ),
        (err) => errorResult(`error: ${err.message}`),
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
          return errorResult(blocked)
        }
      }

      const clientResult = await clientForTeammate(db, zulipSite, sender)
      if (clientResult.isErr()) {
        return errorResult(`error: ${JSON.stringify(clientResult.error)}`)
      }
      const senderClient = clientResult.value

      if (to !== undefined) {
        const result = await sendDirectMessage(senderClient, { to: [to], content })
        return result.match(
          (res) => textResult(`sent DM (id: ${res.id})`),
          (err) => errorResult(`error: ${JSON.stringify(err)}`),
        )
      }

      if (stream && topic) {
        const result = await sendStreamMessage(senderClient, { to: stream, topic, content })
        return result.match(
          (res) => textResult(`posted to ${stream}/${topic} (id: ${res.id})`),
          (err) => errorResult(`error: ${JSON.stringify(err)}`),
        )
      }

      return errorResult('error: provide either "to" (for DMs) or "stream" and "topic"')
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
      // Resolve client: bot client if sender provided, otherwise admin
      let readClient = adminClient
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
        () => textResult(`subscribed to ${topic ? `${stream}/${topic}` : stream}`),
        (err) => errorResult(`error: ${err.message}`),
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
        () => textResult(`unsubscribed from ${target}`),
        (err) => errorResult(`error: ${err.message}`),
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
          return textResult(lines.length === 0 ? '(no subscriptions)' : lines.join('\n'))
        },
        (err) => errorResult(`error: ${err.message}`),
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
        return errorResult(`error: ${teammateResult.error.message}`)
      }

      const teammate = teammateResult.value

      const botClientResult = await clientForTeammate(db, zulipSite, sender)
      if (botClientResult.isErr()) {
        return errorResult(`error: ${JSON.stringify(botClientResult.error)}`)
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
        return textResult('(no subscriptions)')
      }

      // Fetch unread messages from all subscriptions in parallel (without marking read yet)
      const fetchResults = await Promise.all(
        subs.map((sub) => {
          const narrow = [
            { operator: 'stream', operand: sub.stream },
            ...(sub.topic ? [{ operator: 'topic', operand: sub.topic }] : []),
          ]
          return fetchMessages(
            botClient,
            {
              anchor: 'first_unread',
              numBefore: 0,
              numAfter: maxMessages,
              narrow,
              applyMarkdown: false,
            },
            { streamFallback: sub.stream, topicFallback: sub.topic },
          )
        }),
      )

      const allMessages = fetchResults.flatMap((r) => (r.isOk() ? [...r.value] : []))

      // Sort by timestamp, take most recent maxMessages
      allMessages.sort((a, b) => a.timestamp - b.timestamp)
      const trimmed = allMessages.slice(-maxMessages)

      if (trimmed.length === 0) {
        return textResult('(no unread messages across your subscriptions)')
      }

      // Mark only the messages we're returning as read
      await markAsRead(
        botClient,
        trimmed.map((m) => m.id),
      )

      const header =
        allMessages.length > maxMessages
          ? `Showing ${trimmed.length} of ${allMessages.length} unread messages (most recent):\n\n`
          : ''

      return textResult(`${header}${formatMessages(trimmed, true)}`)
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
