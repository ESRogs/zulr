import { err, errAsync, ok, type Result, type ResultAsync } from 'neverthrow'
import type {
  ChannelName,
  DeleteMessageEvent,
  DisplayName,
  EmojiName,
  Event,
  EventId,
  GetMessagesResponse,
  GetSentMessagesParams,
  Member,
  Message,
  MessageEvent,
  MessageId,
  Reaction,
  StreamId,
  Subscription,
  TopicName,
  UnixEpochSeconds,
  UpdateMessageEvent,
  UpdateMessageParams,
  UpdateMessageResponse,
  UserId,
  UserTopicVisibility,
  ZulipClient,
  ZulipError,
} from 'zulip-ts'
import {
  getEvents,
  getMembers,
  getSentMessages,
  isKnownEvent,
  registerQueue,
  updateMessage,
} from 'zulip-ts'
import {
  applyRealmUserEvent,
  emptyMembers,
  initMembers,
  type MembersState,
  resolveName as membersResolveName,
  resolveUserId as membersResolveUserId,
} from './members.ts'
import {
  addApiMessages,
  addEventMessage,
  applyReactionEvent,
  evictOneMessage as cacheEvictOneMessage,
  getEditHistory as cacheGetEditHistory,
  getMessage as cacheGetMessage,
  getMessages as cacheGetMessages,
  getMessagesBySender as cacheGetMessagesBySender,
  getReactionCount as cacheGetReactionCount,
  getReactions as cacheGetReactions,
  canServeFromCache,
  dmNarrowKey,
  type EditEntry,
  emptyMessageListDataCache,
  evictMessages,
  type MessageListDataCache,
  type NarrowKey,
  streamNarrowKey,
  updateMessageContent,
} from './message-list-data.ts'
import { evaluateNotification, type NotificationResult } from './notifications.ts'
import {
  applySubscriptionEvent,
  emptySubscriptionState,
  initSubscriptionState,
  type SubscriptionState,
  getAllSubscriptions as subGetAll,
  getSubscription as subGetById,
  getSubscriptionByName as subGetByName,
  isSubscribed as subIsSubscribed,
} from './subscription-state.ts'
import {
  applyUserTopicEvent,
  emptyTopicVisibility,
  type FollowedTopic,
  initTopicVisibility,
  type TopicVisibilityState,
  getFollowedTopics as tvGetFollowedTopics,
  getTopicVisibility as tvGetTopicVisibility,
  isFollowed as tvIsFollowed,
} from './topic-visibility.ts'
import {
  applyFlagsEvent,
  emptyUnreadState,
  getUnreadCount,
  getUnreadDmCount,
  getUnreadMessageIds,
  hasUnreadDms,
  hasUnreads,
  initUnreadState,
  type UnreadState,
  applyDeleteMessageEvent as unreadApplyDelete,
  applyMessageEvent as unreadApplyMessage,
  applyUpdateMessageEvent as unreadApplyUpdate,
} from './unread-state.ts'

const RETRY_DELAY_MS = 5000

export type SessionEventHandler = {
  /** Called for every event received from the queue. */
  readonly onEvent?: (event: Event) => void
  /** Called when a message event triggers a notification. */
  readonly onNotification?: (event: MessageEvent, result: NotificationResult) => void
  /** Called on errors (network, API, validation). Session continues after errors. */
  readonly onError?: (error: ZulipError | string) => void
}

export type ZulipSession = {
  // Unread state (streams)
  readonly getUnreadCount: (streamId: StreamId, topic: TopicName) => number
  readonly getUnreadMessageIds: (streamId: StreamId, topic: TopicName) => readonly MessageId[]
  readonly hasUnreads: (streamId: StreamId, topic: TopicName) => boolean

  // Unread state (DMs)
  readonly getUnreadDmCount: (userId: UserId) => number
  readonly hasUnreadDms: (userId: UserId) => boolean

  // Topic visibility
  readonly getTopicVisibility: (streamId: StreamId, topic: TopicName) => UserTopicVisibility
  readonly isFollowed: (streamId: StreamId, topic: TopicName) => boolean
  readonly getFollowedTopics: () => readonly FollowedTopic[]

  // Members
  readonly resolveUserId: (id: UserId) => DisplayName | undefined
  readonly resolveName: (name: DisplayName) => Member | undefined

  // Message cache
  readonly getMessage: (id: MessageId) => Message | undefined
  readonly getMessages: (key: NarrowKey, count: number) => readonly Message[]
  readonly canServeFromCache: (key: NarrowKey, count: number) => boolean
  readonly getReactions: (id: MessageId) => readonly Reaction[]
  readonly getReactionCount: (id: MessageId, emojiName: EmojiName) => number
  /** Get the edit history for a cached message. Only populated when trackEditHistory is enabled. */
  readonly getEditHistory: (id: MessageId) => readonly EditEntry[]
  /** Get cached messages sent by a user, optionally scoped to a narrow. */
  readonly getMessagesBySender: (senderId: UserId, narrowKey?: NarrowKey) => readonly Message[]
  /** Store messages from an API fetch so subsequent reads can hit cache. */
  readonly addApiMessages: (
    key: NarrowKey,
    messages: readonly Message[],
    flags: { readonly foundOldest: boolean; readonly foundNewest: boolean },
  ) => void
  /** Edit a message via the API. Cache is updated when the resulting event arrives. */
  readonly editMessage: (
    messageId: MessageId,
    params: UpdateMessageParams,
  ) => ResultAsync<UpdateMessageResponse, ZulipError>
  /** Timestamp when the session last registered its event queue. Undefined before start. */
  readonly getRegisteredAt: () => UnixEpochSeconds | undefined

  // Subscriptions
  readonly isSubscribed: (streamId: StreamId) => boolean
  readonly getSubscription: (streamId: StreamId) => Subscription | undefined
  readonly getSubscriptionByName: (name: ChannelName) => Subscription | undefined
  readonly getAllSubscriptions: () => readonly Subscription[]

  // Self-user identity
  /** The authenticated user's ID, populated from the /register response. Undefined before start. */
  readonly getOwnUserId: () => UserId | undefined
  /** Fetch messages sent by this session's user. Uses the stored user ID as the sender narrow. */
  readonly getOwnSentMessages: (
    params?: Omit<GetSentMessagesParams, 'sender'>,
  ) => ResultAsync<GetMessagesResponse, ZulipError | string>

  // Notification check
  readonly shouldNotify: (event: MessageEvent) => NotificationResult

  // Lifecycle
  readonly start: () => Promise<void>
  readonly stop: () => void

  // For testing: direct access to internal state
  readonly getState: () => {
    readonly unreads: UnreadState
    readonly topicVisibility: TopicVisibilityState
    readonly members: MembersState
    readonly messageCache: MessageListDataCache
    readonly subscriptions: SubscriptionState
  }
}

export type CreateSessionParams = {
  readonly client: ZulipClient
  readonly eventTypes?: readonly string[]
  readonly handler?: SessionEventHandler
  readonly signal?: AbortSignal
  /** If true, receive events for all public channels, not just subscribed ones. */
  readonly allPublicStreams?: boolean
  /** If true, record content edit history for cached messages. Off by default. */
  readonly trackEditHistory?: boolean
}

const DEFAULT_EVENT_TYPES = [
  'message',
  'update_message',
  'delete_message',
  'update_message_flags',
  'reaction',
  'user_topic',
  'realm_user',
  'subscription',
] as const

export function createSession(params: CreateSessionParams): ZulipSession {
  const {
    client,
    eventTypes = DEFAULT_EVENT_TYPES,
    handler,
    signal,
    allPublicStreams,
    trackEditHistory,
  } = params

  let unreads: UnreadState = emptyUnreadState()
  let topicVisibility: TopicVisibilityState = emptyTopicVisibility()
  let members: MembersState = emptyMembers()
  let messageCache: MessageListDataCache = emptyMessageListDataCache({ trackEditHistory })
  let subscriptions: SubscriptionState = emptySubscriptionState()
  let registeredAt: UnixEpochSeconds | undefined
  let ownUserId: UserId | undefined
  let stopped = false

  async function start(): Promise<void> {
    stopped = false

    while (!stopped && !signal?.aborted) {
      const result = await runEventLoop()
      if (result.isErr()) {
        handler?.onError?.(result.error)
        if (!stopped && !signal?.aborted) {
          await sleep(RETRY_DELAY_MS, signal)
        }
      }
      // BAD_EVENT_QUEUE_ID or other loop exit — re-register
    }
  }

  async function runEventLoop(): Promise<Result<void, ZulipError | string>> {
    // eslint-disable-next-line neverthrow/must-use-result
    const regResult = await registerQueue(client, {
      eventTypes: [...eventTypes],
      fetchEventTypes: ['message', 'user_topic', 'subscription'],
      allPublicStreams,
    })

    if (regResult.isErr()) return err(regResult.error)

    const {
      queue_id: queueId,
      last_event_id: initialLastEventId,
      user_id: regUserId,
      unread_msgs,
      user_topics,
      subscriptions: initialSubs,
    } = regResult.value

    // Initialize state from the register response
    if (regUserId) ownUserId = regUserId
    registeredAt = Math.floor(Date.now() / 1000) as UnixEpochSeconds
    unreads = unread_msgs ? initUnreadState(unread_msgs) : emptyUnreadState()
    topicVisibility = user_topics ? initTopicVisibility(user_topics) : emptyTopicVisibility()
    messageCache = emptyMessageListDataCache({ trackEditHistory })
    subscriptions = initialSubs ? initSubscriptionState(initialSubs) : emptySubscriptionState()

    // Fetch members list
    // eslint-disable-next-line neverthrow/must-use-result
    const membersResult = await getMembers(client)
    if (membersResult.isOk()) {
      members = initMembers(membersResult.value.members)
    } else {
      handler?.onError?.(membersResult.error)
      members = emptyMembers()
    }

    let lastEventId: EventId = initialLastEventId

    while (!stopped && !signal?.aborted) {
      // eslint-disable-next-line neverthrow/must-use-result
      const eventsResult = await getEvents(client, { queueId, lastEventId })

      if (eventsResult.isErr()) {
        const evtErr = eventsResult.error
        if (evtErr.type === 'api' && evtErr.code === 'BAD_EVENT_QUEUE_ID') {
          // Queue expired — break to re-register
          return ok(undefined)
        }
        return err(evtErr)
      }

      for (const event of eventsResult.value.events) {
        lastEventId = event.id

        if (isKnownEvent(event)) {
          if (event.type === 'message') {
            unreadApplyMessage(unreads, event)
            const key = narrowKeyForMessage(event.message)
            addEventMessage(messageCache, key, event.message)
            const notification = evaluateNotification(event, topicVisibility)
            if (notification.shouldNotify) {
              handler?.onNotification?.(event, notification)
            }
          } else if (event.type === 'update_message') {
            unreadApplyUpdate(unreads, event)
            handleUpdateMessageEvent(messageCache, event)
          } else if (event.type === 'delete_message') {
            unreadApplyDelete(unreads, event)
            handleDeleteMessageEvent(messageCache, event)
          } else if (event.type === 'update_message_flags') {
            applyFlagsEvent(unreads, event)
          } else if (event.type === 'user_topic') {
            applyUserTopicEvent(topicVisibility, event)
          } else if (event.type === 'realm_user') {
            applyRealmUserEvent(members, event)
          } else if (event.type === 'subscription') {
            applySubscriptionEvent(subscriptions, event)
          } else if (event.type === 'reaction') {
            applyReactionEvent(messageCache, event)
          }
        }

        handler?.onEvent?.(event)
      }
    }

    return ok(undefined)
  }

  function stop(): void {
    stopped = true
  }

  return {
    getUnreadCount: (streamId, topic) => getUnreadCount(unreads, streamId, topic),
    getUnreadMessageIds: (streamId, topic) => getUnreadMessageIds(unreads, streamId, topic),
    hasUnreads: (streamId, topic) => hasUnreads(unreads, streamId, topic),
    getUnreadDmCount: (userId) => getUnreadDmCount(unreads, userId),
    hasUnreadDms: (userId) => hasUnreadDms(unreads, userId),
    getTopicVisibility: (streamId, topic) => tvGetTopicVisibility(topicVisibility, streamId, topic),
    isFollowed: (streamId, topic) => tvIsFollowed(topicVisibility, streamId, topic),
    getFollowedTopics: () => tvGetFollowedTopics(topicVisibility),
    resolveUserId: (id) => membersResolveUserId(members, id),
    resolveName: (name) => membersResolveName(members, name),
    getMessage: (id) => cacheGetMessage(messageCache, id),
    getMessages: (key, count) => cacheGetMessages(messageCache, key, count),
    canServeFromCache: (key, count) => canServeFromCache(messageCache, key, count),
    getReactions: (id) => cacheGetReactions(messageCache, id),
    getReactionCount: (id, emojiName) => cacheGetReactionCount(messageCache, id, emojiName),
    getEditHistory: (id) => cacheGetEditHistory(messageCache, id),
    getMessagesBySender: (senderId, narrowKey) =>
      cacheGetMessagesBySender(messageCache, senderId, narrowKey),
    addApiMessages: (key, messages, flags) => addApiMessages(messageCache, key, messages, flags),
    editMessage: (messageId, params) => updateMessage(client, messageId, params),
    getRegisteredAt: () => registeredAt,
    isSubscribed: (streamId) => subIsSubscribed(subscriptions, streamId),
    getSubscription: (streamId) => subGetById(subscriptions, streamId),
    getSubscriptionByName: (name) => subGetByName(subscriptions, name),
    getAllSubscriptions: () => subGetAll(subscriptions),
    getOwnUserId: () => ownUserId,
    getOwnSentMessages: (params) => {
      if (!ownUserId) {
        return errAsync('session has not started yet — own user ID is not available')
      }
      return getSentMessages(client, { sender: ownUserId, ...params })
    },
    shouldNotify: (event) => evaluateNotification(event, topicVisibility),
    start,
    stop,
    getState: () => ({ unreads, topicVisibility, members, messageCache, subscriptions }),
  }
}

function narrowKeyForMessage(msg: Message): NarrowKey {
  if (msg.type === 'stream') {
    return streamNarrowKey(msg.stream_id, msg.subject)
  }
  return dmNarrowKey(msg.sender_id)
}

function handleUpdateMessageEvent(cache: MessageListDataCache, event: UpdateMessageEvent): void {
  const isTopicMove = !!event.orig_subject
  const isStreamMove = !!event.new_stream_id

  if (isTopicMove || isStreamMove) {
    // Topic or stream move — evict from old narrow
    if (event.orig_subject && event.stream_id) {
      evictMessages(cache, streamNarrowKey(event.stream_id, event.orig_subject), event.message_ids)
    }
    if (isStreamMove && event.stream_id && event.subject) {
      evictMessages(cache, streamNarrowKey(event.stream_id, event.subject), event.message_ids)
    }
  } else if (event.content !== undefined) {
    // Content-only edit — update in-place
    const edit =
      event.orig_content !== undefined && event.edit_timestamp !== undefined
        ? { prevContent: event.orig_content, editTimestamp: event.edit_timestamp }
        : undefined
    for (const id of event.message_ids) {
      updateMessageContent(cache, id, event.content, edit)
    }
  }
}

function handleDeleteMessageEvent(cache: MessageListDataCache, event: DeleteMessageEvent): void {
  if (event.stream_id && event.topic) {
    cacheEvictOneMessage(cache, streamNarrowKey(event.stream_id, event.topic), event.message_id)
  }
  // For DM deletes, we don't have the sender_id — the message may or may not be cached.
  // The global messageIndex is cleaned up by evictOneMessage if the narrow is found.
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
