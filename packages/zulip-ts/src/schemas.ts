import { z } from 'zod'
import type {
  ApiKey,
  ChannelName,
  DisplayName,
  Email,
  EmojiName,
  EventId,
  MessageId,
  QueueId,
  StreamId,
  TopicName,
  UnixEpochSeconds,
  UserId,
} from './tagged-types.ts'

export type {
  ApiKey,
  ChannelName,
  DisplayName,
  Email,
  EmojiName,
  EventId,
  MessageId,
  QueueId,
  StreamId,
  TopicName,
  UnixEpochSeconds,
  UserId,
} from './tagged-types.ts'

const userId = z.number().transform((n): UserId => n as UserId)
const messageId = z.number().transform((n): MessageId => n as MessageId)
const streamId = z.number().transform((n): StreamId => n as StreamId)
const eventId = z.number().transform((n): EventId => n as EventId)
const unixEpochSeconds = z.number().transform((n): UnixEpochSeconds => n as UnixEpochSeconds)
const channelName = z.string().transform((s): ChannelName => s as ChannelName)
const topicName = z.string().transform((s): TopicName => s as TopicName)
const email = z.string().transform((s): Email => s as Email)
const displayName = z.string().transform((s): DisplayName => s as DisplayName)
const emojiName = z.string().transform((s): EmojiName => s as EmojiName)
const queueId = z.string().transform((s): QueueId => s as QueueId)
const apiKey = z.string().transform((s): ApiKey => s as ApiKey)

export const SuccessResponseFields = {
  result: z.literal('success'),
  msg: z.string(),
}

export const SuccessResponseSchema = z.object(SuccessResponseFields)
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>

// --- Messages ---

const ReactionSchema = z.object({
  emoji_name: emojiName,
  user_id: userId,
})
export type Reaction = z.infer<typeof ReactionSchema>

const BaseMessageFields = {
  id: messageId,
  sender_id: userId,
  sender_email: email,
  sender_full_name: displayName,
  content: z.string(),
  timestamp: unixEpochSeconds,
  reactions: z.array(ReactionSchema).optional().default([]),
}

export const DmRecipientSchema = z.object({
  id: userId,
  email: email,
  full_name: displayName,
})
export type DmRecipient = z.infer<typeof DmRecipientSchema>

export const StreamMessageSchema = z.object({
  ...BaseMessageFields,
  type: z.literal('stream'),
  stream_id: streamId,
  display_recipient: channelName,
  subject: topicName,
})
export type StreamMessage = z.infer<typeof StreamMessageSchema>

export const DmMessageSchema = z.object({
  ...BaseMessageFields,
  type: z.literal('private'),
  display_recipient: z.array(DmRecipientSchema),
  subject: topicName.optional(),
})
export type DmMessage = z.infer<typeof DmMessageSchema>

export const MessageSchema = z.discriminatedUnion('type', [StreamMessageSchema, DmMessageSchema])
export type Message = z.infer<typeof MessageSchema>

export const SendMessageResponseSchema = z.object({
  ...SuccessResponseFields,
  id: messageId,
})
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>

export const GetMessageResponseSchema = z.object({
  ...SuccessResponseFields,
  message: MessageSchema,
})
export type GetMessageResponse = z.infer<typeof GetMessageResponseSchema>

export const GetMessagesResponseSchema = z.object({
  ...SuccessResponseFields,
  messages: z.array(MessageSchema),
})
export type GetMessagesResponse = z.infer<typeof GetMessagesResponseSchema>

export const UpdateMessageFlagsResponseSchema = z.object({
  ...SuccessResponseFields,
  messages: z.array(messageId),
})
export type UpdateMessageFlagsResponse = z.infer<typeof UpdateMessageFlagsResponseSchema>

export const UpdateMessageResponseSchema = z.object(SuccessResponseFields)
export type UpdateMessageResponse = z.infer<typeof UpdateMessageResponseSchema>

// --- Streams ---

export const StreamSchema = z.object({
  stream_id: streamId,
  name: channelName,
  description: z.string().optional(),
})
export type Stream = z.infer<typeof StreamSchema>

export const GetStreamsResponseSchema = z.object({
  ...SuccessResponseFields,
  streams: z.array(StreamSchema),
})
export type GetStreamsResponse = z.infer<typeof GetStreamsResponseSchema>

export const SubscribeResponseSchema = z.object({
  ...SuccessResponseFields,
  subscribed: z.record(z.string(), z.array(z.string())),
  already_subscribed: z.record(z.string(), z.array(z.string())),
})
export type SubscribeResponse = z.infer<typeof SubscribeResponseSchema>

export const UnsubscribeResponseSchema = z.object({
  ...SuccessResponseFields,
  removed: z.array(z.string()),
  not_removed: z.array(z.string()),
})
export type UnsubscribeResponse = z.infer<typeof UnsubscribeResponseSchema>

export const SubscriptionSchema = z.object({
  stream_id: streamId,
  name: channelName,
  description: z.string().optional(),
})
export type Subscription = z.infer<typeof SubscriptionSchema>

export const GetSubscriptionsResponseSchema = z.object({
  ...SuccessResponseFields,
  subscriptions: z.array(SubscriptionSchema),
})
export type GetSubscriptionsResponse = z.infer<typeof GetSubscriptionsResponseSchema>

export const UpdateChannelResponseSchema = z.object(SuccessResponseFields)
export type UpdateChannelResponse = z.infer<typeof UpdateChannelResponseSchema>

export const CreateChannelResponseSchema = z.object({
  ...SuccessResponseFields,
  id: streamId,
})
export type CreateChannelResponse = z.infer<typeof CreateChannelResponseSchema>

export const GetStreamResponseSchema = z.object({
  ...SuccessResponseFields,
  stream: StreamSchema,
})
export type GetStreamResponse = z.infer<typeof GetStreamResponseSchema>

export const GetStreamMembersResponseSchema = z.object({
  ...SuccessResponseFields,
  subscribers: z.array(userId),
})
export type GetStreamMembersResponse = z.infer<typeof GetStreamMembersResponseSchema>

export const TopicSchema = z.object({
  name: topicName,
  max_id: messageId,
})
export type Topic = z.infer<typeof TopicSchema>

export const GetTopicsResponseSchema = z.object({
  ...SuccessResponseFields,
  topics: z.array(TopicSchema),
})
export type GetTopicsResponse = z.infer<typeof GetTopicsResponseSchema>

// --- Users ---

export const MemberSchema = z.object({
  user_id: userId,
  email: email,
  delivery_email: email.nullable().optional(),
  full_name: displayName,
  is_bot: z.boolean().optional(),
})
export type Member = z.infer<typeof MemberSchema>

export const GetMembersResponseSchema = z.object({
  ...SuccessResponseFields,
  members: z.array(MemberSchema),
})
export type GetMembersResponse = z.infer<typeof GetMembersResponseSchema>

// --- Bots ---

export const BotSchema = z.object({
  user_id: userId.optional(),
  username: email,
  full_name: displayName,
  api_key: apiKey,
  bot_type: z.number().optional(),
})
export type Bot = z.infer<typeof BotSchema>

export const GetBotsResponseSchema = z.object({
  ...SuccessResponseFields,
  bots: z.array(BotSchema),
})
export type GetBotsResponse = z.infer<typeof GetBotsResponseSchema>

export const CreateBotResponseSchema = z.object({
  ...SuccessResponseFields,
  user_id: userId,
  api_key: apiKey,
})
export type CreateBotResponse = z.infer<typeof CreateBotResponseSchema>

// --- Unread Messages (from /register initial state) ---

export const UnreadStreamEntrySchema = z.object({
  stream_id: streamId,
  topic: topicName,
  unread_message_ids: z.array(messageId),
})
export type UnreadStreamEntry = z.infer<typeof UnreadStreamEntrySchema>

export const UnreadDmEntrySchema = z.object({
  other_user_id: userId,
  unread_message_ids: z.array(messageId),
})
export type UnreadDmEntry = z.infer<typeof UnreadDmEntrySchema>

export const UnreadMsgsSchema = z.object({
  count: z.number(),
  pms: z.array(UnreadDmEntrySchema),
  streams: z.array(UnreadStreamEntrySchema),
  mentions: z.array(messageId),
})
export type UnreadMsgs = z.infer<typeof UnreadMsgsSchema>

// --- User Topic Visibility (from /register initial state) ---

export const UserTopicEntrySchema = z.object({
  stream_id: streamId,
  topic_name: topicName,
  visibility_policy: z.number(),
  last_updated: unixEpochSeconds.optional(),
})
export type UserTopicEntry = z.infer<typeof UserTopicEntrySchema>

// --- Events ---

export const RegisterQueueResponseSchema = z.object({
  ...SuccessResponseFields,
  queue_id: queueId,
  last_event_id: eventId,
  /** The authenticated user's ID. Returned by Zulip on every /register call. */
  user_id: userId.optional(),
  unread_msgs: UnreadMsgsSchema.optional(),
  user_topics: z.array(UserTopicEntrySchema).optional(),
  subscriptions: z.array(SubscriptionSchema).optional(),
})
export type RegisterQueueResponse = z.infer<typeof RegisterQueueResponseSchema>

// --- Per-type event schemas ---

const BaseEventFields = {
  id: eventId,
}

export const MessageEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal('message'),
  message: MessageSchema,
  flags: z.array(z.string()),
})
export type MessageEvent = z.infer<typeof MessageEventSchema>

export const UpdateMessageEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal('update_message'),
  message_id: messageId,
  message_ids: z.array(messageId),
  content: z.string().optional(),
  orig_content: z.string().optional(),
  subject: topicName.optional(),
  orig_subject: topicName.optional(),
  new_stream_id: streamId.optional(),
  stream_id: streamId.optional(),
  rendering_only: z.boolean().optional(),
})
export type UpdateMessageEvent = z.infer<typeof UpdateMessageEventSchema>

export const DeleteMessageEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal('delete_message'),
  message_id: messageId,
  message_type: z.string(),
  stream_id: streamId.optional(),
  topic: topicName.optional(),
})
export type DeleteMessageEvent = z.infer<typeof DeleteMessageEventSchema>

export const UpdateMessageFlagsEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal('update_message_flags'),
  op: z.enum(['add', 'remove']),
  flag: z.string(),
  messages: z.array(messageId),
  all: z.boolean().optional(),
})
export type UpdateMessageFlagsEvent = z.infer<typeof UpdateMessageFlagsEventSchema>

export const ReactionEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal('reaction'),
  op: z.enum(['add', 'remove']),
  message_id: messageId,
  user_id: userId,
  emoji_name: emojiName,
})
export type ReactionEvent = z.infer<typeof ReactionEventSchema>

export const UserTopicEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal('user_topic'),
  stream_id: streamId,
  topic_name: topicName,
  visibility_policy: z.number(),
})
export type UserTopicEvent = z.infer<typeof UserTopicEventSchema>

// passthrough() because Zulip includes different fields in the person object
// depending on which user attribute changed (avatar, timezone, custom profile
// fields, etc.). We parse the fields we use and preserve the rest unvalidated.
const RealmUserPersonSchema = z
  .object({
    user_id: userId,
    email: email.optional(),
    full_name: displayName.optional(),
    is_bot: z.boolean().optional(),
    delivery_email: email.nullable().optional(),
  })
  .passthrough()

export const RealmUserEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal('realm_user'),
  op: z.string(),
  person: RealmUserPersonSchema,
})
export type RealmUserEvent = z.infer<typeof RealmUserEventSchema>

export const SubscriptionEventSchema = z.object({
  ...BaseEventFields,
  type: z.literal('subscription'),
  op: z.string(),
  subscriptions: z.array(SubscriptionSchema),
})
export type SubscriptionEvent = z.infer<typeof SubscriptionEventSchema>

/** Catch-all for event types we don't have specific schemas for. */
export const UnknownEventSchema = z
  .object({
    ...BaseEventFields,
    type: z.string(),
  })
  .passthrough()
export type UnknownEvent = z.infer<typeof UnknownEventSchema>

/** Discriminated union of known event types — enables TypeScript narrowing on `event.type`. */
export const KnownEventSchema = z.discriminatedUnion('type', [
  MessageEventSchema,
  UpdateMessageEventSchema,
  DeleteMessageEventSchema,
  UpdateMessageFlagsEventSchema,
  ReactionEventSchema,
  UserTopicEventSchema,
  RealmUserEventSchema,
  SubscriptionEventSchema,
])
export type KnownEvent = z.infer<typeof KnownEventSchema>

const KNOWN_EVENT_TYPES = new Set<string>([
  'message',
  'update_message',
  'delete_message',
  'update_message_flags',
  'reaction',
  'user_topic',
  'realm_user',
  'subscription',
])

/** Type guard: narrows Event to KnownEvent for discriminated union narrowing on `event.type`. */
export function isKnownEvent(event: Event): event is KnownEvent {
  return KNOWN_EVENT_TYPES.has(event.type)
}

/** Parse an event, trying known types first, falling back to the catch-all. */
export const EventSchema: z.ZodType<KnownEvent | UnknownEvent> = z.union([
  KnownEventSchema,
  UnknownEventSchema,
])
export type Event = KnownEvent | UnknownEvent

export const GetEventsResponseSchema = z.object({
  ...SuccessResponseFields,
  events: z.array(EventSchema),
})
export type GetEventsResponse = z.infer<typeof GetEventsResponseSchema>
