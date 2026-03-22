import type { MessageEvent } from 'zulip-ts'
import type { TopicVisibilityState } from './topic-visibility.ts'
import { isFollowed } from './topic-visibility.ts'

export type NotificationResult = {
  readonly shouldNotify: boolean
  readonly reason: 'dm' | 'mentioned' | 'wildcard_mentioned' | 'followed_topic' | 'silent'
}

/**
 * Determine whether a message event should trigger a notification.
 *
 * Matches Zulip's notification trigger logic:
 * - DM → always notify
 * - @-mention or wildcard mention (from event flags) → notify
 * - Topic is FOLLOWED (visibility policy 3) → notify
 * - Otherwise → silent (unread state is still updated)
 */
export function evaluateNotification(
  event: MessageEvent,
  topicVisibility: TopicVisibilityState,
): NotificationResult {
  const msg = event.message

  // DMs always notify
  if (msg.type === 'private') {
    return { shouldNotify: true, reason: 'dm' }
  }

  // Check flags for mentions
  const flags = event.flags
  if (flags.includes('mentioned')) {
    return { shouldNotify: true, reason: 'mentioned' }
  }
  if (flags.includes('wildcard_mentioned')) {
    return { shouldNotify: true, reason: 'wildcard_mentioned' }
  }

  // Check topic follow state
  if (isFollowed(topicVisibility, msg.stream_id, msg.subject)) {
    return { shouldNotify: true, reason: 'followed_topic' }
  }

  return { shouldNotify: false, reason: 'silent' }
}
