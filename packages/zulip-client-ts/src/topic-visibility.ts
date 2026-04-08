import type {
  StreamId,
  TopicName,
  UserTopicEntry,
  UserTopicEvent,
  UserTopicVisibility,
} from 'zulip-ts'

export type TopicVisibilityState = Map<StreamId, Map<TopicName, UserTopicVisibility>>

/** Normalize a topic name for case-insensitive lookup (Zulip treats topics as case-insensitive). */
export function normalizeTopicName(topic: TopicName): TopicName {
  return topic.toLowerCase() as TopicName
}

/** Create an empty topic visibility state. */
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
    topicMap.set(normalizeTopicName(entry.topic_name), policy)
  }
  return state
}

/** Apply a user_topic event — updates topic visibility policy. */
export function applyUserTopicEvent(state: TopicVisibilityState, event: UserTopicEvent): void {
  const visibilityPolicy = event.visibility_policy as UserTopicVisibility
  const topic = normalizeTopicName(event.topic_name)

  if (visibilityPolicy === 0) {
    // INHERIT — remove the override, fall back to channel default
    const topicMap = state.get(event.stream_id)
    if (topicMap) {
      topicMap.delete(topic)
      if (topicMap.size === 0) state.delete(event.stream_id)
    }
    return
  }

  let topicMap = state.get(event.stream_id)
  if (!topicMap) {
    topicMap = new Map()
    state.set(event.stream_id, topicMap)
  }
  topicMap.set(topic, visibilityPolicy)
}

/** Get the visibility policy for a topic. Returns 0 (INHERIT) if no override is set. */
export function getTopicVisibility(
  state: TopicVisibilityState,
  streamId: StreamId,
  topic: TopicName,
): UserTopicVisibility {
  return state.get(streamId)?.get(normalizeTopicName(topic)) ?? 0
}

/** Check whether a topic has FOLLOWED visibility policy. */
export function isFollowed(
  state: TopicVisibilityState,
  streamId: StreamId,
  topic: TopicName,
): boolean {
  return getTopicVisibility(state, streamId, topic) === 3
}

export type FollowedTopic = { readonly streamId: StreamId; readonly topic: TopicName }

/** Return all topics with visibility policy FOLLOWED (3). */
export function getFollowedTopics(state: TopicVisibilityState): readonly FollowedTopic[] {
  const result: FollowedTopic[] = []
  for (const [streamId, topicMap] of state) {
    for (const [topic, policy] of topicMap) {
      if (policy === 3) result.push({ streamId, topic })
    }
  }
  return result
}
