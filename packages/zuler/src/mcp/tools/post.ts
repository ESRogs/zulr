import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getTopics, sendDirectMessage, sendStreamMessage } from 'zulip-ts'
import { subscribeAndFollow } from '../../zulip/follow.ts'
import { checkUnreadBeforeDm, checkUnreadBeforePost } from '../../zulip/unread-check.ts'
import {
  errorResult,
  formatError,
  type ToolContext,
  textResult,
  zChannelName,
  zTeammateName,
  zTopicName,
} from '../helpers.ts'

export function registerPostTool(server: McpServer, ctx: ToolContext): void {
  const { teamName } = ctx.config

  server.registerTool(
    'post',
    {
      description:
        'Send a Zulip message. For DMs, provide "to" as a user ID, name, or email. For channel messages, provide "channel" and "topic". To @-mention a teammate, use @**full name** (e.g. @**scout**) — this auto-subscribes them to the topic. By default, posting to a non-existent topic is blocked — set createTopic: true to create a new topic. Checks for unread messages in your teammate inbox before sending — use the read or catch-up tool first if blocked.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Name of the registered teammate sending the message'),
        content: z.string().describe('Message content'),
        to: z
          .union([z.number(), z.string()])
          .optional()
          .describe('User ID, full name, or email for DMs'),
        channel: zChannelName.optional().describe('Channel name'),
        topic: zTopicName.optional().describe('Topic name'),
        createTopic: z
          .union([z.boolean(), z.string().transform((s) => s === 'true')])
          .optional()
          .default(false)
          .describe(
            'Set to true to allow posting to a topic that does not yet exist (default: false)',
          ),
      }),
    },
    async ({ sender, content, to, channel, topic, createTopic }) => {
      // Pre-flight unread checks before any async work
      if (channel && topic) {
        const blocked = checkUnreadBeforePost(teamName, sender, channel, topic)
        if (blocked) {
          return errorResult(blocked)
        }
      }

      if (to !== undefined) {
        const resolveResult = await ctx.resolveUser(to)
        if (resolveResult.isErr()) {
          return errorResult(resolveResult.error)
        }
        const recipient = resolveResult.value

        const dmBlocked = checkUnreadBeforeDm(teamName, sender, recipient.user_id)
        if (dmBlocked) {
          return errorResult(dmBlocked)
        }

        if (recipient.is_bot) {
          return errorResult(
            'bots cannot DM other bots. Use a channel/topic for bot-to-bot communication.',
          )
        }

        const clientResult = await ctx.getTeammateClient(sender)
        if (clientResult.isErr()) {
          return errorResult(clientResult.error)
        }

        const result = await sendDirectMessage(clientResult.value.client, {
          to: [recipient.user_id],
          content,
        })
        return result.match(
          (res) => textResult(`sent DM to ${recipient.full_name} (id: ${res.id})`),
          (err) => errorResult(formatError(err)),
        )
      }

      if (channel && topic) {
        const clientResult = await ctx.getTeammateClient(sender)
        if (clientResult.isErr()) {
          return errorResult(clientResult.error)
        }

        if (!createTopic) {
          const channelResult = await ctx.resolveChannel(channel)
          if (channelResult.isErr()) {
            return errorResult(channelResult.error)
          }
          const topicsResult = await getTopics(
            clientResult.value.client,
            channelResult.value.stream_id,
          )
          if (topicsResult.isErr()) {
            return errorResult(formatError(topicsResult.error))
          }
          const topicLower = topic.toLowerCase()
          const exists = topicsResult.value.topics.some((t) => t.name.toLowerCase() === topicLower)
          if (!exists) {
            const existing = topicsResult.value.topics.map((t) => t.name)
            const topicList =
              existing.length > 0
                ? `Existing topics:\n${existing.map((n) => `  - ${n}`).join('\n')}`
                : 'This channel has no topics yet.'
            return errorResult(
              `Topic "${topic}" does not exist in #${channel}. Set createTopic: true to create it, or check the topic name.\n\n${topicList}`,
            )
          }
        }

        const result = await sendStreamMessage(clientResult.value.client, {
          to: channel,
          topic,
          content,
        })
        if (result.isOk()) {
          // Subscribe to the channel and follow the topic so the bot receives
          // notifications for future messages in this topic
          const followErr = await ctx
            .resolveChannel(channel)
            .andThen((stream) =>
              subscribeAndFollow(
                clientResult.value.client,
                channel,
                stream.stream_id,
                topic,
              ).mapErr(formatError),
            )
            .match(
              () => undefined,
              (err) => err,
            )
          const msg = `posted to ${channel}/${topic} (id: ${result.value.id})`
          return textResult(
            followErr ? `${msg} — warning: failed to follow topic: ${followErr}` : msg,
          )
        }
        return result.match(
          () => textResult(`posted to ${channel}/${topic}`),
          (err) => errorResult(formatError(err)),
        )
      }

      return errorResult('provide either "to" (for DMs) or "channel" and "topic"')
    },
  )
}
