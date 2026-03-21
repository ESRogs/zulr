export type { MembersState } from './members.ts'
export {
  applyRealmUserEvent,
  emptyMembers,
  initMembers,
  resolveName,
  resolveUserId,
} from './members.ts'

export type { MessageCache } from './message-cache.ts'
export {
  addMessage,
  applyDeleteMessageEvent as cacheApplyDeleteMessage,
  applyMessageEvent as cacheApplyMessage,
  applyUpdateMessageEvent as cacheApplyUpdateMessage,
  emptyMessageCache,
  getMessage,
  getTopicMessages,
  removeMessage,
} from './message-cache.ts'

export type { NotificationResult } from './notifications.ts'
export { evaluateNotification } from './notifications.ts'

export type { CreateSessionParams, SessionEventHandler, ZulipSession } from './session.ts'
export { createSession } from './session.ts'

export type { SubscriptionState } from './subscription-state.ts'
export {
  applySubscriptionEvent,
  emptySubscriptionState,
  getAllSubscriptions,
  getSubscription,
  getSubscriptionByName,
  initSubscriptionState,
  isSubscribed,
} from './subscription-state.ts'

export type { TopicVisibilityState } from './topic-visibility.ts'
export {
  applyUserTopicEvent,
  emptyTopicVisibility,
  getTopicVisibility,
  initTopicVisibility,
  isFollowed,
} from './topic-visibility.ts'

export type { UnreadState } from './unread-state.ts'
export {
  applyDeleteMessageEvent as unreadApplyDeleteMessage,
  applyFlagsEvent,
  applyMessageEvent as unreadApplyMessage,
  applyUpdateMessageEvent as unreadApplyUpdate,
  emptyUnreadState,
  getUnreadCount,
  getUnreadDmCount,
  getUnreadMessageIds,
  hasUnreadDms,
  hasUnreads,
  initUnreadState,
} from './unread-state.ts'
