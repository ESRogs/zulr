import { z } from 'zod'
import { setTopicVisibility, TopicVisibility } from 'zulip-ts'
import {
  errorResult,
  getErrorMessage,
  type ToolContext,
  type ToolRegistrar,
  textResult,
  zChannelName,
  zTeammateName,
  zTopicName,
} from '../helpers.ts'

export function registerFollowTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'follow',
    {
      description:
        'Follow a Zulip topic to receive notifications for all messages. Posting to a topic auto-follows it, so this is only needed to follow a topic without posting.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
        topic: zTopicName.describe('Topic name'),
      }),
    },
    async ({ sender, channel, topic }) => {
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const channelResult = await ctx.cache.resolveChannel(channel)
      if (channelResult.isErr()) return errorResult(channelResult.error)

      const result = await setTopicVisibility(
        clientResult.value.client,
        channelResult.value.stream_id,
        topic,
        TopicVisibility.FOLLOWED,
      )
      return result.match(
        () => textResult(`following ${channel}/${topic}`),
        (err) => errorResult(getErrorMessage(err)),
      )
    },
  )
}

export function registerMuteTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'mute',
    {
      description: 'Mute a Zulip topic to suppress notifications.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
        topic: zTopicName.describe('Topic name'),
      }),
    },
    async ({ sender, channel, topic }) => {
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const channelResult = await ctx.cache.resolveChannel(channel)
      if (channelResult.isErr()) return errorResult(channelResult.error)

      const result = await setTopicVisibility(
        clientResult.value.client,
        channelResult.value.stream_id,
        topic,
        TopicVisibility.MUTED,
      )
      return result.match(
        () => textResult(`muted ${channel}/${topic}`),
        (err) => errorResult(getErrorMessage(err)),
      )
    },
  )
}

export function registerUnmuteTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'unmute',
    {
      description:
        'Unmute a Zulip topic (overrides channel-level mute). Use this to restore notifications for a previously muted topic.',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
        topic: zTopicName.describe('Topic name'),
      }),
    },
    async ({ sender, channel, topic }) => {
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const channelResult = await ctx.cache.resolveChannel(channel)
      if (channelResult.isErr()) return errorResult(channelResult.error)

      const result = await setTopicVisibility(
        clientResult.value.client,
        channelResult.value.stream_id,
        topic,
        TopicVisibility.UNMUTED,
      )
      return result.match(
        () => textResult(`unmuted ${channel}/${topic}`),
        (err) => errorResult(getErrorMessage(err)),
      )
    },
  )
}

export function registerUnfollowTool(registrar: ToolRegistrar, ctx: ToolContext): void {
  registrar.registerTool(
    'unfollow',
    {
      description:
        'Stop following a Zulip topic. Use this when you no longer need to participate in a conversation (e.g. after answering a specific question).',
      inputSchema: z.object({
        sender: zTeammateName.describe('Teammate name'),
        channel: zChannelName.describe('Channel name'),
        topic: zTopicName.describe('Topic name'),
      }),
    },
    async ({ sender, channel, topic }) => {
      const clientResult = await ctx.getTeammateClient(sender)
      if (clientResult.isErr()) return errorResult(clientResult.error)

      const channelResult = await ctx.cache.resolveChannel(channel)
      if (channelResult.isErr()) return errorResult(channelResult.error)

      const result = await setTopicVisibility(
        clientResult.value.client,
        channelResult.value.stream_id,
        topic,
        TopicVisibility.INHERIT,
      )
      return result.match(
        () => textResult(`unfollowed ${channel}/${topic}`),
        (err) => errorResult(getErrorMessage(err)),
      )
    },
  )
}
