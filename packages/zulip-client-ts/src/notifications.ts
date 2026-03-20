import type { Event, StreamId, TopicName } from 'zulip-ts'
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
  event: Event,
  topicVisibility: TopicVisibilityState,
): NotificationResult {
  const msg = event.message
  if (!msg) return { shouldNotify: false, reason: 'silent' }

  // DMs always notify
  if (msg.type === 'private') {
    return { shouldNotify: true, reason: 'dm' }
  }

  // Check flags for mentions
  const flags = event.flags ?? []
  if (flags.includes('mentioned')) {
    return { shouldNotify: true, reason: 'mentioned' }
  }
  if (flags.includes('wildcard_mentioned')) {
    return { shouldNotify: true, reason: 'wildcard_mentioned' }
  }

  // Check topic follow state
  const streamId = msg.stream_id
  const topic = msg.subject
  if (isFollowed(topicVisibility, streamId as StreamId, topic as TopicName)) {
    return { shouldNotify: true, reason: 'followed_topic' }
  }

  return { shouldNotify: false, reason: 'silent' }
}
