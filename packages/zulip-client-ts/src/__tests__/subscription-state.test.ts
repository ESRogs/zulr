import { describe, expect, test } from 'bun:test'
import type { ChannelName, Event, EventId, StreamId, Subscription } from 'zulip-ts'
import {
  applySubscriptionEvent,
  emptySubscriptionState,
  getAllSubscriptions,
  getSubscription,
  getSubscriptionByName,
  initSubscriptionState,
  isSubscribed,
} from '../subscription-state.ts'

function sid(n: number): StreamId {
  return n as StreamId
}
function eid(n: number): EventId {
  return n as EventId
}
function chan(s: string): ChannelName {
  return s as ChannelName
}

function makeSub(id: number, name: string): Subscription {
  return { stream_id: sid(id), name: chan(name) }
}

describe('initSubscriptionState', () => {
  test('initializes from subscription list', () => {
    const state = initSubscriptionState([makeSub(10, 'general'), makeSub(20, 'design')])

    expect(isSubscribed(state, sid(10))).toBe(true)
    expect(isSubscribed(state, sid(20))).toBe(true)
    expect(isSubscribed(state, sid(99))).toBe(false)
  })

  test('supports lookup by name', () => {
    const state = initSubscriptionState([makeSub(10, 'general')])
    const sub = getSubscriptionByName(state, chan('general'))
    expect(sub?.stream_id).toBe(sid(10))
  })

  test('returns undefined for unknown name', () => {
    const state = initSubscriptionState([makeSub(10, 'general')])
    expect(getSubscriptionByName(state, chan('nope'))).toBeUndefined()
  })
})

describe('emptySubscriptionState', () => {
  test('has no subscriptions', () => {
    const state = emptySubscriptionState()
    expect(isSubscribed(state, sid(1))).toBe(false)
    expect(getAllSubscriptions(state)).toEqual([])
  })
})

describe('applySubscriptionEvent', () => {
  test('adds subscriptions on add event', () => {
    const state = emptySubscriptionState()

    const event = {
      type: 'subscription',
      id: eid(1),
      op: 'add',
      subscriptions: [makeSub(10, 'general'), makeSub(20, 'design')],
    } as Event

    applySubscriptionEvent(state, event)
    expect(isSubscribed(state, sid(10))).toBe(true)
    expect(isSubscribed(state, sid(20))).toBe(true)
    expect(getAllSubscriptions(state)).toHaveLength(2)
  })

  test('removes subscriptions on remove event', () => {
    const state = initSubscriptionState([makeSub(10, 'general'), makeSub(20, 'design')])

    const event = {
      type: 'subscription',
      id: eid(1),
      op: 'remove',
      subscriptions: [makeSub(10, 'general')],
    } as Event

    applySubscriptionEvent(state, event)
    expect(isSubscribed(state, sid(10))).toBe(false)
    expect(isSubscribed(state, sid(20))).toBe(true)
    expect(getSubscriptionByName(state, chan('general'))).toBeUndefined()
  })

  test('no-ops when event has no subscriptions', () => {
    const state = initSubscriptionState([makeSub(10, 'general')])

    const event = { type: 'subscription', id: eid(1), op: 'add' } as Event
    applySubscriptionEvent(state, event)
    expect(getAllSubscriptions(state)).toHaveLength(1)
  })
})

describe('getSubscription', () => {
  test('returns subscription by ID', () => {
    const state = initSubscriptionState([makeSub(10, 'general')])
    const sub = getSubscription(state, sid(10))
    expect(sub?.name).toBe(chan('general'))
  })

  test('returns undefined for unknown ID', () => {
    const state = emptySubscriptionState()
    expect(getSubscription(state, sid(99))).toBeUndefined()
  })
})
