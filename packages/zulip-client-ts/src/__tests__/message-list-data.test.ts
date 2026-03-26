import { describe, expect, test } from 'bun:test'
import type {
  ChannelName,
  Message,
  MessageId,
  StreamId,
  TopicName,
  UnixEpochSeconds,
  UserId,
} from 'zulip-ts'
import {
  addApiMessages,
  addEventMessage,
  canServeFromCache,
  deleteMessage,
  dmNarrowKey,
  emptyMessageListDataCache,
  evictMessages,
  getMessage,
  getMessages,
  getMessagesBySender,
  type NarrowKey,
  streamNarrowKey,
  updateMessageContent,
} from '../message-list-data.ts'

// --- Helpers ---

function msgId(n: number): MessageId {
  return n as MessageId
}
function sid(n: number): StreamId {
  return n as StreamId
}
function uid(n: number): UserId {
  return n as UserId
}
function topic(s: string): TopicName {
  return s as TopicName
}

function streamNarrow(streamId: number, topicName: string): NarrowKey {
  return `stream\0${streamId}\0${topicName}` as NarrowKey
}

function dmNarrow(userId: number): NarrowKey {
  return `dm\0${userId}` as NarrowKey
}

function makeStreamMessage(overrides: {
  id: number
  streamId?: number
  subject?: string
  content?: string
  timestamp?: number
  senderId?: number
}): Message {
  return {
    id: msgId(overrides.id),
    type: 'stream' as const,
    stream_id: sid(overrides.streamId ?? 10),
    display_recipient: 'general' as ChannelName,
    subject: topic(overrides.subject ?? 'test-topic'),
    sender_id: uid(overrides.senderId ?? 1),
    sender_email: 'user@example.com' as never,
    sender_full_name: 'User' as never,
    content: overrides.content ?? `message ${overrides.id}`,
    timestamp: (overrides.timestamp ?? 1000 + overrides.id) as UnixEpochSeconds,
    reactions: [],
  }
}

function makeDmMessage(overrides: { id: number; senderId?: number; content?: string }): Message {
  return {
    id: msgId(overrides.id),
    type: 'private' as const,
    display_recipient: [
      {
        id: uid(overrides.senderId ?? 1),
        email: 'user@example.com' as never,
        full_name: 'User' as never,
      },
    ],
    sender_id: uid(overrides.senderId ?? 1),
    sender_email: 'user@example.com' as never,
    sender_full_name: 'User' as never,
    content: overrides.content ?? `dm ${overrides.id}`,
    timestamp: (1000 + overrides.id) as UnixEpochSeconds,
    reactions: [],
  }
}

// --- Tests ---

describe('emptyMessageListDataCache', () => {
  test('creates an empty cache', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')
    expect(canServeFromCache(cache, key, 1)).toBe(false)
    expect(getMessages(cache, key, 10)).toEqual([])
  })
})

describe('addEventMessage', () => {
  test('adds a stream message to the correct narrow', () => {
    const cache = emptyMessageListDataCache()
    const msg = makeStreamMessage({ id: 100 })
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, msg)

    expect(getMessages(cache, key, 10)).toEqual([msg])
  })

  test('adds a DM to the correct narrow', () => {
    const cache = emptyMessageListDataCache()
    const msg = makeDmMessage({ id: 200, senderId: 5 })
    const key = dmNarrow(5)

    addEventMessage(cache, key, msg)

    expect(getMessages(cache, key, 10)).toEqual([msg])
  })

  test('maintains sorted order when messages arrive in order', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 3 }))

    const msgs = getMessages(cache, key, 10)
    expect(msgs.map((m) => m.id)).toEqual([msgId(1), msgId(2), msgId(3)])
  })

  test('event-delivered messages set hasFoundNewest to true', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))

    // After receiving an event, we know we have the newest — cache can serve
    // if we only need messages we already have
    expect(canServeFromCache(cache, key, 1)).toBe(true)
  })

  test('different narrows are independent', () => {
    const cache = emptyMessageListDataCache()
    const key1 = streamNarrow(10, 'topic-a')
    const key2 = streamNarrow(10, 'topic-b')

    addEventMessage(cache, key1, makeStreamMessage({ id: 1, subject: 'topic-a' }))
    addEventMessage(cache, key2, makeStreamMessage({ id: 2, subject: 'topic-b' }))

    expect(getMessages(cache, key1, 10).map((m) => m.id)).toEqual([msgId(1)])
    expect(getMessages(cache, key2, 10).map((m) => m.id)).toEqual([msgId(2)])
  })
})

describe('addApiMessages', () => {
  test('caches API results when foundNewest is true on empty narrow', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')
    const msgs = [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })]

    addApiMessages(cache, key, msgs, { foundOldest: false, foundNewest: true })

    expect(getMessages(cache, key, 10).map((m) => m.id)).toEqual([msgId(1), msgId(2)])
  })

  test('does not cache API results when foundNewest is false on empty narrow', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')
    const msgs = [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })]

    addApiMessages(cache, key, msgs, { foundOldest: true, foundNewest: false })

    // Not cached — we don't have the newest message
    expect(getMessages(cache, key, 10)).toEqual([])
    expect(canServeFromCache(cache, key, 1)).toBe(false)
  })

  test('serves from cache when both foundOldest and foundNewest are true', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')
    const msgs = [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })]

    addApiMessages(cache, key, msgs, { foundOldest: true, foundNewest: true })

    // Complete topic — both boundaries known
    expect(canServeFromCache(cache, key, 2)).toBe(true)
    expect(canServeFromCache(cache, key, 5)).toBe(true) // hasFoundOldest, so we have everything
  })

  test('API messages merge with event-delivered messages when contiguous', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    // Event-delivered messages (newest)
    addEventMessage(cache, key, makeStreamMessage({ id: 5 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 6 }))

    // API-fetched messages that connect to the event range
    // (message 4 is right before message 5)
    addApiMessages(cache, key, [makeStreamMessage({ id: 3 }), makeStreamMessage({ id: 4 })], {
      foundOldest: false,
      foundNewest: true,
    })

    const msgs = getMessages(cache, key, 10)
    expect(msgs.map((m) => m.id)).toEqual([msgId(3), msgId(4), msgId(5), msgId(6)])
    expect(canServeFromCache(cache, key, 4)).toBe(true)
  })

  test('API messages are discarded when there is a gap with existing cache', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    // Event-delivered messages at IDs 100, 101
    addEventMessage(cache, key, makeStreamMessage({ id: 100 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 101 }))

    // API fetch returns IDs 1, 2 — big gap, doesn't connect
    addApiMessages(cache, key, [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })], {
      foundOldest: false,
      foundNewest: false,
    })

    // Existing event-delivered messages are preserved; disconnected API results are discarded
    const msgs = getMessages(cache, key, 10)
    expect(msgs.map((m) => m.id)).toEqual([msgId(100), msgId(101)])
  })

  test('does not cache API results without foundNewest even on empty narrow', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addApiMessages(cache, key, [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })], {
      foundOldest: false,
      foundNewest: false,
    })

    // Not cached — no foundNewest means there's effectively a gap at the top
    expect(getMessages(cache, key, 10)).toEqual([])
  })

  test('API messages with foundOldest and foundNewest gives complete topic', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')
    const msgs = [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })]

    addApiMessages(cache, key, msgs, { foundOldest: true, foundNewest: true })

    expect(canServeFromCache(cache, key, 100)).toBe(true)
  })
})

describe('canServeFromCache', () => {
  test('returns false for empty cache', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')
    expect(canServeFromCache(cache, key, 1)).toBe(false)
  })

  test('returns false for unknown narrow', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(99, 'unknown')
    expect(canServeFromCache(cache, key, 5)).toBe(false)
  })

  test('returns true when event-delivered messages satisfy count', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 3 }))

    expect(canServeFromCache(cache, key, 3)).toBe(true)
    expect(canServeFromCache(cache, key, 2)).toBe(true)
    expect(canServeFromCache(cache, key, 1)).toBe(true)
  })

  test('returns false when count exceeds cached messages and hasFoundOldest is false', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2 }))

    // We have 2 messages but don't know if there are older ones
    expect(canServeFromCache(cache, key, 3)).toBe(false)
  })

  test('returns true when hasFoundOldest even with fewer messages than requested', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addApiMessages(cache, key, [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })], {
      foundOldest: true,
      foundNewest: true,
    })

    // Only 2 messages exist in the topic, so requesting 10 still serves from cache
    expect(canServeFromCache(cache, key, 10)).toBe(true)
  })

  test('returns true for count 0', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))

    expect(canServeFromCache(cache, key, 0)).toBe(true)
  })

  test('returns false when API results were not cached (foundNewest was false)', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    // API fetch without foundNewest — results are not cached at all
    addApiMessages(cache, key, [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })], {
      foundOldest: false,
      foundNewest: false,
    })

    // Nothing was cached, so canServe returns false
    expect(canServeFromCache(cache, key, 2)).toBe(false)
    expect(canServeFromCache(cache, key, 1)).toBe(false)
  })

  test('returns true when hasFoundNewest is true from API fetch', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addApiMessages(cache, key, [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })], {
      foundOldest: false,
      foundNewest: true,
    })

    expect(canServeFromCache(cache, key, 2)).toBe(true)
    expect(canServeFromCache(cache, key, 1)).toBe(true)
    // But not enough for 3 since hasFoundOldest is false
    expect(canServeFromCache(cache, key, 3)).toBe(false)
  })
})

describe('getMessages', () => {
  test('returns messages sorted by ID ascending', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 3 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2 }))

    expect(getMessages(cache, key, 10).map((m) => m.id)).toEqual([msgId(1), msgId(2), msgId(3)])
  })

  test('returns at most count messages from the newest end', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    for (let i = 1; i <= 10; i++) {
      addEventMessage(cache, key, makeStreamMessage({ id: i }))
    }

    const msgs = getMessages(cache, key, 3)
    expect(msgs.map((m) => m.id)).toEqual([msgId(8), msgId(9), msgId(10)])
  })

  test('returns all messages when count exceeds available', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2 }))

    const msgs = getMessages(cache, key, 10)
    expect(msgs.map((m) => m.id)).toEqual([msgId(1), msgId(2)])
  })

  test('returns empty array for unknown narrow', () => {
    const cache = emptyMessageListDataCache()
    expect(getMessages(cache, streamNarrow(99, 'nope'), 10)).toEqual([])
  })
})

describe('deleteMessage', () => {
  test('removes a message from the narrow', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 3 }))

    deleteMessage(cache, key, msgId(2))

    expect(getMessages(cache, key, 10).map((m) => m.id)).toEqual([msgId(1), msgId(3)])
  })

  test('no-ops for unknown message', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))

    deleteMessage(cache, key, msgId(999))

    expect(getMessages(cache, key, 10).map((m) => m.id)).toEqual([msgId(1)])
  })

  test('no-ops for unknown narrow', () => {
    const cache = emptyMessageListDataCache()
    deleteMessage(cache, streamNarrow(99, 'nope'), msgId(1)) // should not throw
  })

  test('preserves hasFoundOldest after deletion', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addApiMessages(
      cache,
      key,
      [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 }), makeStreamMessage({ id: 3 })],
      { foundOldest: true, foundNewest: true },
    )

    deleteMessage(cache, key, msgId(2))

    // Still has complete coverage — deleting doesn't create a gap
    expect(canServeFromCache(cache, key, 10)).toBe(true)
    expect(getMessages(cache, key, 10).map((m) => m.id)).toEqual([msgId(1), msgId(3)])
  })
})

describe('LRU eviction', () => {
  test('evicts least recently accessed narrow when exceeding max narrows', () => {
    const maxNarrows = 3
    const cache = emptyMessageListDataCache(maxNarrows)

    // Add 3 narrows — all fit
    const key1 = streamNarrow(10, 'topic-1')
    const key2 = streamNarrow(10, 'topic-2')
    const key3 = streamNarrow(10, 'topic-3')

    addEventMessage(cache, key1, makeStreamMessage({ id: 1, subject: 'topic-1' }))
    addEventMessage(cache, key2, makeStreamMessage({ id: 2, subject: 'topic-2' }))
    addEventMessage(cache, key3, makeStreamMessage({ id: 3, subject: 'topic-3' }))

    // All should be present
    expect(getMessages(cache, key1, 10).length).toBe(1)
    expect(getMessages(cache, key2, 10).length).toBe(1)
    expect(getMessages(cache, key3, 10).length).toBe(1)

    // Add a 4th narrow — should evict key1 (least recently used)
    const key4 = streamNarrow(10, 'topic-4')
    addEventMessage(cache, key4, makeStreamMessage({ id: 4, subject: 'topic-4' }))

    expect(getMessages(cache, key1, 10).length).toBe(0) // evicted
    expect(getMessages(cache, key2, 10).length).toBe(1)
    expect(getMessages(cache, key3, 10).length).toBe(1)
    expect(getMessages(cache, key4, 10).length).toBe(1)
  })

  test('accessing a narrow updates its recency', () => {
    const maxNarrows = 3
    const cache = emptyMessageListDataCache(maxNarrows)

    const key1 = streamNarrow(10, 'topic-1')
    const key2 = streamNarrow(10, 'topic-2')
    const key3 = streamNarrow(10, 'topic-3')

    addEventMessage(cache, key1, makeStreamMessage({ id: 1, subject: 'topic-1' }))
    addEventMessage(cache, key2, makeStreamMessage({ id: 2, subject: 'topic-2' }))
    addEventMessage(cache, key3, makeStreamMessage({ id: 3, subject: 'topic-3' }))

    // Access key1 — makes it most recently used
    getMessages(cache, key1, 10)

    // Add a 4th narrow — should evict key2 (now least recently used)
    const key4 = streamNarrow(10, 'topic-4')
    addEventMessage(cache, key4, makeStreamMessage({ id: 4, subject: 'topic-4' }))

    expect(getMessages(cache, key1, 10).length).toBe(1) // still present — was accessed
    expect(getMessages(cache, key2, 10).length).toBe(0) // evicted
    expect(getMessages(cache, key3, 10).length).toBe(1)
    expect(getMessages(cache, key4, 10).length).toBe(1)
  })
})

describe('DM narrows', () => {
  test('tracks DM messages in a separate narrow', () => {
    const cache = emptyMessageListDataCache()
    const streamKey = streamNarrow(10, 'test-topic')
    const dmKey = dmNarrow(5)

    addEventMessage(cache, streamKey, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, dmKey, makeDmMessage({ id: 2, senderId: 5 }))

    expect(getMessages(cache, streamKey, 10).map((m) => m.id)).toEqual([msgId(1)])
    expect(getMessages(cache, dmKey, 10).map((m) => m.id)).toEqual([msgId(2)])
  })
})

describe('narrow key constructors', () => {
  test('streamNarrowKey produces consistent keys', () => {
    const key1 = streamNarrowKey(sid(10), topic('bugs'))
    const key2 = streamNarrowKey(sid(10), topic('bugs'))
    const key3 = streamNarrowKey(sid(10), topic('features'))

    expect(key1).toBe(key2)
    expect(key1).not.toBe(key3)
  })

  test('dmNarrowKey produces consistent keys', () => {
    const key1 = dmNarrowKey(uid(5))
    const key2 = dmNarrowKey(uid(5))
    const key3 = dmNarrowKey(uid(6))

    expect(key1).toBe(key2)
    expect(key1).not.toBe(key3)
  })

  test('stream and DM keys do not collide', () => {
    const streamKey = streamNarrowKey(sid(5), topic('test'))
    const dmKey = dmNarrowKey(uid(5))

    expect(streamKey).not.toBe(dmKey)
  })
})

describe('getMessage (global index)', () => {
  test('looks up a message by ID across narrows', () => {
    const cache = emptyMessageListDataCache()
    const key1 = streamNarrow(10, 'topic-a')
    const key2 = streamNarrow(10, 'topic-b')

    const msg1 = makeStreamMessage({ id: 1, subject: 'topic-a' })
    const msg2 = makeStreamMessage({ id: 2, subject: 'topic-b' })

    addEventMessage(cache, key1, msg1)
    addEventMessage(cache, key2, msg2)

    expect(getMessage(cache, msgId(1))).toBe(msg1)
    expect(getMessage(cache, msgId(2))).toBe(msg2)
  })

  test('returns undefined for unknown message ID', () => {
    const cache = emptyMessageListDataCache()
    expect(getMessage(cache, msgId(999))).toBeUndefined()
  })

  test('removes from global index on deleteMessage', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    expect(getMessage(cache, msgId(1))).toBeDefined()

    deleteMessage(cache, key, msgId(1))
    expect(getMessage(cache, msgId(1))).toBeUndefined()
  })

  test('removes from global index on LRU eviction', () => {
    const cache = emptyMessageListDataCache(2)

    const key1 = streamNarrow(10, 'topic-1')
    const key2 = streamNarrow(10, 'topic-2')
    const key3 = streamNarrow(10, 'topic-3')

    addEventMessage(cache, key1, makeStreamMessage({ id: 1, subject: 'topic-1' }))
    addEventMessage(cache, key2, makeStreamMessage({ id: 2, subject: 'topic-2' }))

    expect(getMessage(cache, msgId(1))).toBeDefined()

    // Adding key3 should evict key1
    addEventMessage(cache, key3, makeStreamMessage({ id: 3, subject: 'topic-3' }))

    expect(getMessage(cache, msgId(1))).toBeUndefined() // evicted
    expect(getMessage(cache, msgId(2))).toBeDefined()
    expect(getMessage(cache, msgId(3))).toBeDefined()
  })

  test('discarded gap messages are not added to global index', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    // Event-delivered messages
    addEventMessage(cache, key, makeStreamMessage({ id: 100 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 101 }))
    expect(getMessage(cache, msgId(100))).toBeDefined()
    expect(getMessage(cache, msgId(101))).toBeDefined()

    // API fetch with gap — disconnected messages are discarded
    addApiMessages(cache, key, [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 })], {
      foundOldest: false,
      foundNewest: false,
    })

    // Existing messages preserved
    expect(getMessage(cache, msgId(100))).toBeDefined()
    expect(getMessage(cache, msgId(101))).toBeDefined()
    // Disconnected messages not indexed
    expect(getMessage(cache, msgId(1))).toBeUndefined()
    expect(getMessage(cache, msgId(2))).toBeUndefined()
  })
})

describe('evictMessages', () => {
  test('removes multiple messages from a narrow (content edit eviction)', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 3 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 4 }))

    evictMessages(cache, key, [msgId(2), msgId(3)])

    expect(getMessages(cache, key, 10).map((m) => m.id)).toEqual([msgId(1), msgId(4)])
  })

  test('removes evicted messages from global index', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2 }))

    evictMessages(cache, key, [msgId(1)])

    expect(getMessage(cache, msgId(1))).toBeUndefined()
    expect(getMessage(cache, msgId(2))).toBeDefined()
  })

  test('no-ops for unknown narrow', () => {
    const cache = emptyMessageListDataCache()
    evictMessages(cache, streamNarrow(99, 'nope'), [msgId(1)]) // should not throw
  })

  test('no-ops for unknown message IDs', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1 }))

    evictMessages(cache, key, [msgId(999)])

    expect(getMessages(cache, key, 10).map((m) => m.id)).toEqual([msgId(1)])
  })

  test('preserves hasFoundOldest and hasFoundNewest after eviction', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addApiMessages(
      cache,
      key,
      [makeStreamMessage({ id: 1 }), makeStreamMessage({ id: 2 }), makeStreamMessage({ id: 3 })],
      { foundOldest: true, foundNewest: true },
    )

    evictMessages(cache, key, [msgId(2)])

    expect(canServeFromCache(cache, key, 10)).toBe(true)
    expect(getMessages(cache, key, 10).map((m) => m.id)).toEqual([msgId(1), msgId(3)])
  })
})

describe('narrow key delimiter', () => {
  test('topic names with colons do not cause key collisions', () => {
    const key1 = streamNarrowKey(sid(10), topic('topic:with:colons'))
    const key2 = streamNarrowKey(sid(10), topic('topic'))

    expect(key1).not.toBe(key2)

    // Also verify the key is stable
    const key1b = streamNarrowKey(sid(10), topic('topic:with:colons'))
    expect(key1).toBe(key1b)
  })
})

describe('updateMessageContent', () => {
  test('updates content of a cached message in-place', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')
    const msg = makeStreamMessage({ id: 1, content: 'original' })
    addEventMessage(cache, key, msg)

    updateMessageContent(cache, msgId(1), 'edited')

    const retrieved = getMessage(cache, msgId(1))
    expect(retrieved?.content).toBe('edited')

    // Also visible via getMessages
    const messages = getMessages(cache, key, 10)
    expect(messages[0].content).toBe('edited')
  })

  test('no-op for uncached message ID', () => {
    const cache = emptyMessageListDataCache()
    // Should not throw
    updateMessageContent(cache, msgId(999), 'edited')
    expect(getMessage(cache, msgId(999))).toBeUndefined()
  })

  test('updates message visible in multiple narrows via messageIndex', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')
    const msg = makeStreamMessage({ id: 1, content: 'original' })
    addEventMessage(cache, key, msg)

    // The messageIndex and narrow share the same object reference
    updateMessageContent(cache, msgId(1), 'edited')

    expect(getMessage(cache, msgId(1))?.content).toBe('edited')
    expect(getMessages(cache, key, 10)[0].content).toBe('edited')
  })
})

describe('getMessagesBySender', () => {
  test('returns messages by a specific sender across narrows', () => {
    const cache = emptyMessageListDataCache()
    const key1 = streamNarrow(10, 'topic-a')
    const key2 = streamNarrow(10, 'topic-b')

    addEventMessage(cache, key1, makeStreamMessage({ id: 1, senderId: 5, subject: 'topic-a' }))
    addEventMessage(cache, key1, makeStreamMessage({ id: 2, senderId: 7, subject: 'topic-a' }))
    addEventMessage(cache, key2, makeStreamMessage({ id: 3, senderId: 5, subject: 'topic-b' }))

    const result = getMessagesBySender(cache, uid(5))
    expect(result.map((m) => m.id)).toEqual([msgId(1), msgId(3)])
  })

  test('scoped to a narrow returns only messages in that narrow', () => {
    const cache = emptyMessageListDataCache()
    const key1 = streamNarrow(10, 'topic-a')
    const key2 = streamNarrow(10, 'topic-b')

    addEventMessage(cache, key1, makeStreamMessage({ id: 1, senderId: 5, subject: 'topic-a' }))
    addEventMessage(cache, key2, makeStreamMessage({ id: 2, senderId: 5, subject: 'topic-b' }))

    const result = getMessagesBySender(cache, uid(5), key1)
    expect(result.map((m) => m.id)).toEqual([msgId(1)])
  })

  test('returns empty array for unknown sender', () => {
    const cache = emptyMessageListDataCache()
    expect(getMessagesBySender(cache, uid(99))).toEqual([])
  })

  test('updates when messages are deleted', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1, senderId: 5 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2, senderId: 5 }))
    expect(getMessagesBySender(cache, uid(5)).length).toBe(2)

    deleteMessage(cache, key, msgId(1))
    expect(getMessagesBySender(cache, uid(5)).map((m) => m.id)).toEqual([msgId(2)])
  })

  test('updates when messages are evicted', () => {
    const cache = emptyMessageListDataCache()
    const key = streamNarrow(10, 'test-topic')

    addEventMessage(cache, key, makeStreamMessage({ id: 1, senderId: 5 }))
    addEventMessage(cache, key, makeStreamMessage({ id: 2, senderId: 5 }))

    evictMessages(cache, key, [msgId(1)])
    expect(getMessagesBySender(cache, uid(5)).map((m) => m.id)).toEqual([msgId(2)])
  })

  test('cleans up sender index when narrow is LRU-evicted', () => {
    const cache = emptyMessageListDataCache(1) // max 1 narrow

    const key1 = streamNarrow(10, 'topic-a')
    addEventMessage(cache, key1, makeStreamMessage({ id: 1, senderId: 5, subject: 'topic-a' }))
    expect(getMessagesBySender(cache, uid(5)).length).toBe(1)

    // Adding a second narrow evicts the first
    const key2 = streamNarrow(10, 'topic-b')
    addEventMessage(cache, key2, makeStreamMessage({ id: 2, senderId: 7, subject: 'topic-b' }))

    expect(getMessagesBySender(cache, uid(5))).toEqual([])
    expect(getMessagesBySender(cache, uid(7)).length).toBe(1)
  })
})
