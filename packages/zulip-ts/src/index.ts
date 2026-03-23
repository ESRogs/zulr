export type { CreateBotParams } from './bots.ts'
export { createBot, getBots } from './bots.ts'
export type { ZulipClient, ZulipConfig, ZulipError } from './client.ts'
export { createClient } from './client.ts'
export type { GetEventsParams, RegisterQueueParams } from './events.ts'
export { getEvents, registerQueue } from './events.ts'
export type { DownloadFileResponse, UploadFileResponse } from './files.ts'
export { downloadFile, uploadFile } from './files.ts'
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
  DeleteMessageEvent,
  DmMessage,
  DmRecipient,
  Event,
  GetBotsResponse,
  GetEventsResponse,
  GetMembersResponse,
  GetMessagesResponse,
  GetStreamsResponse,
  GetSubscriptionsResponse,
  KnownEvent,
  Member,
  Message,
  MessageEvent,
  Reaction,
  ReactionEvent,
  RealmUserEvent,
  RegisterQueueResponse,
  SendMessageResponse,
  Stream,
  StreamMessage,
  SubscribeResponse,
  Subscription,
  SubscriptionEvent,
  Topic,
  UnknownEvent,
  UnreadDmEntry,
  UnreadMsgs,
  UnreadStreamEntry,
  UnsubscribeResponse,
  UpdateChannelResponse,
  UpdateMessageEvent,
  UpdateMessageFlagsEvent,
  UpdateMessageFlagsResponse,
  UpdateMessageResponse,
  UserTopicEntry,
  UserTopicEvent,
} from './schemas.ts'
export { isKnownEvent } from './schemas.ts'
export type { CreateChannelParams, UpdateChannelParams, UserTopicVisibility } from './streams.ts'
export {
  archiveStream,
  createChannel,
  getStreams,
  getSubscriptions,
  getTopics,
  setUserTopic,
  subscribe,
  TopicVisibility,
  unsubscribe,
  updateChannel,
} from './streams.ts'
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
export { getMembers, updateSettings } from './users.ts'
