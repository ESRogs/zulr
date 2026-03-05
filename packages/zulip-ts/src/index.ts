export { createClient } from './client.ts';
export type { ZulipClient, ZulipConfig, ZulipError } from './client.ts';

export { sendDirectMessage, sendStreamMessage, getMessages } from './messages.ts';
export type { SendDirectMessageParams, SendStreamMessageParams, GetMessagesParams, NarrowFilter } from './messages.ts';

export { getStreams, subscribe } from './streams.ts';

export { getMembers } from './users.ts';

export { getBots, createBot } from './bots.ts';
export type { CreateBotParams } from './bots.ts';

export { registerQueue, getEvents } from './events.ts';
export type { RegisterQueueParams, GetEventsParams } from './events.ts';

export type {
  Message,
  Stream,
  Member,
  Bot,
  Event,
  SendMessageResponse,
  GetMessagesResponse,
  GetStreamsResponse,
  SubscribeResponse,
  GetMembersResponse,
  GetBotsResponse,
  CreateBotResponse,
  RegisterQueueResponse,
  GetEventsResponse,
} from './schemas.ts';
