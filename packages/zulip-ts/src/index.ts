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
  UpdateMessageParams,
} from './messages.ts'
export {
  addReaction,
  getMessages,
  markAsRead,
  removeReaction,
  sendDirectMessage,
  sendStreamMessage,
  updateMessage,
  updateMessageFlags,
} from './messages.ts'
export type {
  Bot,
  CreateBotResponse,
  CreateChannelResponse,
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
  Topic,
  UpdateChannelResponse,
  UpdateMessageFlagsResponse,
  UpdateMessageResponse,
} from './schemas.ts'
export type { CreateChannelParams, UpdateChannelParams } from './streams.ts'
export {
  archiveStream,
  createChannel,
  getStreams,
  getSubscribers,
  getTopics,
  subscribe,
  updateChannel,
} from './streams.ts'
export { getMembers } from './users.ts'
