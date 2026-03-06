import { z } from 'zod'

// --- Messages ---

export const MessageSchema = z.object({
  id: z.number(),
  sender_id: z.number(),
  sender_email: z.string(),
  sender_full_name: z.string(),
  type: z.enum(['stream', 'private']),
  display_recipient: z.union([
    z.string(),
    z.array(
      z.object({
        id: z.number(),
        email: z.string(),
        full_name: z.string(),
      }),
    ),
  ]),
  subject: z.string().optional(),
  content: z.string(),
  timestamp: z.number(),
})
export type Message = z.infer<typeof MessageSchema>

export const SendMessageResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  id: z.number(),
})
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>

export const GetMessagesResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  messages: z.array(MessageSchema),
})
export type GetMessagesResponse = z.infer<typeof GetMessagesResponseSchema>

// --- Streams ---

export const StreamSchema = z.object({
  stream_id: z.number(),
  name: z.string(),
  description: z.string().optional(),
})
export type Stream = z.infer<typeof StreamSchema>

export const GetStreamsResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  streams: z.array(StreamSchema),
})
export type GetStreamsResponse = z.infer<typeof GetStreamsResponseSchema>

export const SubscribeResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  subscribed: z.record(z.string(), z.array(z.string())),
  already_subscribed: z.record(z.string(), z.array(z.string())),
})
export type SubscribeResponse = z.infer<typeof SubscribeResponseSchema>

// --- Users ---

export const MemberSchema = z.object({
  user_id: z.number(),
  email: z.string(),
  full_name: z.string(),
  is_bot: z.boolean().optional(),
})
export type Member = z.infer<typeof MemberSchema>

export const GetMembersResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  members: z.array(MemberSchema),
})
export type GetMembersResponse = z.infer<typeof GetMembersResponseSchema>

// --- Bots ---

export const BotSchema = z.object({
  user_id: z.number(),
  username: z.string(),
  full_name: z.string(),
  api_key: z.string(),
  bot_type: z.number(),
})
export type Bot = z.infer<typeof BotSchema>

export const GetBotsResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  bots: z.array(BotSchema),
})
export type GetBotsResponse = z.infer<typeof GetBotsResponseSchema>

export const CreateBotResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  user_id: z.number(),
  api_key: z.string(),
})
export type CreateBotResponse = z.infer<typeof CreateBotResponseSchema>

// --- Events ---

export const RegisterQueueResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  queue_id: z.string(),
  last_event_id: z.number(),
})
export type RegisterQueueResponse = z.infer<typeof RegisterQueueResponseSchema>

export const EventSchema = z.object({
  type: z.string(),
  id: z.number(),
  message: MessageSchema.optional(),
})
export type Event = z.infer<typeof EventSchema>

export const GetEventsResponseSchema = z.object({
  result: z.literal('success'),
  msg: z.string(),
  events: z.array(EventSchema),
})
export type GetEventsResponse = z.infer<typeof GetEventsResponseSchema>
