import type { Event, StreamId, TopicName, UserTopicEntry, UserTopicVisibility } from 'zulip-ts'

export type TopicVisibilityState = Map<StreamId, Map<TopicName, UserTopicVisibility>>

export function emptyTopicVisibility(): TopicVisibilityState {
  return new Map()
}

/** Build topic visibility state from the /register response's user_topics. */
export function initTopicVisibility(entries: readonly UserTopicEntry[]): TopicVisibilityState {
  const state: TopicVisibilityState = new Map()
  for (const entry of entries) {
    const policy = entry.visibility_policy as UserTopicVisibility
    if (policy === 0) continue // INHERIT — no override to store
    let topicMap = state.get(entry.stream_id)
    if (!topicMap) {
      topicMap = new Map()
      state.set(entry.stream_id, topicMap)
    }
    topicMap.set(entry.topic_name, policy)
  }
  return state
}

/** Apply a user_topic event — updates topic visibility policy. */
export function applyUserTopicEvent(state: TopicVisibilityState, event: Event): void {
  if (event.type !== 'user_topic') return

  // user_topic events have stream_id, topic_name, visibility_policy on the event object
  const raw = event as unknown as Record<string, unknown>
  const streamId = raw.stream_id as StreamId | undefined
  const topicName = raw.topic_name as TopicName | undefined
  const visibilityPolicy = raw.visibility_policy as UserTopicVisibility | undefined

  if (streamId == null || topicName == null || visibilityPolicy == null) return

  if (visibilityPolicy === 0) {
    // INHERIT — remove the override, fall back to channel default
    const topicMap = state.get(streamId)
    if (topicMap) {
      topicMap.delete(topicName)
      if (topicMap.size === 0) state.delete(streamId)
    }
    return
  }

  let topicMap = state.get(streamId)
  if (!topicMap) {
    topicMap = new Map()
    state.set(streamId, topicMap)
  }
  topicMap.set(topicName, visibilityPolicy)
}

export function getTopicVisibility(
  state: TopicVisibilityState,
  streamId: StreamId,
  topic: TopicName,
): UserTopicVisibility {
  return state.get(streamId)?.get(topic) ?? 0
}

export function isFollowed(
  state: TopicVisibilityState,
  streamId: StreamId,
  topic: TopicName,
): boolean {
  return getTopicVisibility(state, streamId, topic) === 3
}
