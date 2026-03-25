import type { ChannelName, StreamId, Subscription, SubscriptionEvent } from 'zulip-ts'

export type SubscriptionState = {
  /** Subscriptions by stream ID. */
  readonly byId: Map<StreamId, Subscription>
  /** Reverse lookup: channel name → stream ID. */
  readonly byName: Map<ChannelName, StreamId>
}

/** Create an empty subscription state. */
export function emptySubscriptionState(): SubscriptionState {
  return { byId: new Map(), byName: new Map() }
}

/** Build subscription state from the /register response's subscriptions list. */
export function initSubscriptionState(subscriptions: readonly Subscription[]): SubscriptionState {
  const state = emptySubscriptionState()
  for (const sub of subscriptions) {
    state.byId.set(sub.stream_id, sub)
    state.byName.set(sub.name, sub.stream_id)
  }
  return state
}

/** Apply a subscription event (add/remove/update). */
export function applySubscriptionEvent(state: SubscriptionState, event: SubscriptionEvent): void {
  if (event.op === 'add') {
    for (const sub of event.subscriptions) {
      state.byId.set(sub.stream_id, sub)
      state.byName.set(sub.name, sub.stream_id)
    }
  } else if (event.op === 'remove') {
    for (const sub of event.subscriptions) {
      const existing = state.byId.get(sub.stream_id)
      if (existing) {
        state.byName.delete(existing.name)
      }
      state.byId.delete(sub.stream_id)
    }
  }
}

/** Check whether the user is subscribed to a stream. */
export function isSubscribed(state: SubscriptionState, streamId: StreamId): boolean {
  return state.byId.has(streamId)
}

/** Look up a subscription by stream ID. */
export function getSubscription(
  state: SubscriptionState,
  streamId: StreamId,
): Subscription | undefined {
  return state.byId.get(streamId)
}

/** Look up a subscription by channel name. */
export function getSubscriptionByName(
  state: SubscriptionState,
  name: ChannelName,
): Subscription | undefined {
  const id = state.byName.get(name)
  return id !== undefined ? state.byId.get(id) : undefined
}

/** Return all current subscriptions. */
export function getAllSubscriptions(state: SubscriptionState): readonly Subscription[] {
  return [...state.byId.values()]
}
