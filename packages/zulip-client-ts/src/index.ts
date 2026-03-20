export type { CreateSessionParams, SessionEventHandler, ZulipSession } from './session.ts'
export { createSession } from './session.ts'
export type { UnreadState } from './unread-state.ts'
export {
  applyFlagsEvent,
  applyMessageEvent,
  emptyUnreadState,
  getUnreadCount,
  getUnreadDmCount,
  getUnreadMessageIds,
  hasUnreadDms,
  hasUnreads,
  initUnreadState,
} from './unread-state.ts'
