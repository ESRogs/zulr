export type { CreateBotParams } from './bots.ts'
export { createBot, getBots } from './bots.ts'
export type { ZulipClient, ZulipConfig, ZulipError } from './client.ts'
export { createClient } from './client.ts'
export type { GetEventsParams, RegisterQueueParams } from './events.ts'
export { getEvents, registerQueue } from './events.ts'
export type {
  GetMessagesParams,
  NarrowFilter,
  SendDirectMessageParams,
  SendStreamMessageParams,
} from './messages.ts'
export {
  getMessages,
  markAsRead,
  sendDirectMessage,
  sendStreamMessage,
  updateMessageFlags,
} from './messages.ts'
export type {
  Bot,
  CreateBotResponse,
  DmMessage,
  DmRecipient,
  Event,
  GetBotsResponse,
  GetEventsResponse,
  GetMembersResponse,
  GetMessagesResponse,
  GetStreamsResponse,
  Member,
  Message,
  RegisterQueueResponse,
  SendMessageResponse,
  Stream,
  StreamMessage,
  SubscribeResponse,
  UpdateMessageFlagsResponse,
} from './schemas.ts'
export { getStreams, subscribe } from './streams.ts'
export { getMembers } from './users.ts'
