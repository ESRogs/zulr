import { describe, expect, test } from 'bun:test'
import type {
  ChannelName,
  EmojiName,
  EventId,
  Message,
  MessageId,
  ReactionEvent,
  StreamId,
  TopicName,
  UnixEpochSeconds,
  UserId,
} from 'zulip-ts'
import {
  addEventMessage,
  applyReactionEvent,
  emptyMessageListDataCache,
  getMessage,
  getReactionCount,
  getReactions,
  type NarrowKey,
  streamNarrowKey,
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
function emoji(s: string): EmojiName {
  return s as EmojiName
}

function makeStreamMessage(id: number): Message {
  return {
    id: msgId(id),
    type: 'stream' as const,
    stream_id: sid(10),
    display_recipient: 'general' as ChannelName,
    subject: topic('test-topic'),
    sender_id: uid(1),
    sender_email: 'user@example.com' as never,
    sender_full_name: 'User' as never,
    content: `message ${id}`,
    timestamp: (1000 + id) as UnixEpochSeconds,
    reactions: [],
  }
}

function makeReactionEvent(overrides: {
  op: 'add' | 'remove'
  messageId: number
  userId: number
  emojiName: string
}): ReactionEvent {
  return {
    id: 1 as EventId,
    type: 'reaction',
    op: overrides.op,
    message_id: msgId(overrides.messageId),
    user_id: uid(overrides.userId),
    emoji_name: emoji(overrides.emojiName),
  }
}

const key: NarrowKey = streamNarrowKey(sid(10), topic('test-topic'))

// --- Tests ---

describe('applyReactionEvent', () => {
  test('add reaction to a cached message', () => {
    const cache = emptyMessageListDataCache()
    addEventMessage(cache, key, makeStreamMessage(1))

    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 5, emojiName: 'thumbs_up' }),
    )

    const msg = getMessage(cache, msgId(1))
    expect(msg?.reactions).toEqual([{ emoji_name: emoji('thumbs_up'), user_id: uid(5) }])
  })

  test('remove reaction from a cached message', () => {
    const cache = emptyMessageListDataCache()
    addEventMessage(cache, key, makeStreamMessage(1))

    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 5, emojiName: 'thumbs_up' }),
    )
    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'remove', messageId: 1, userId: 5, emojiName: 'thumbs_up' }),
    )

    const msg = getMessage(cache, msgId(1))
    expect(msg?.reactions).toEqual([])
  })

  test('no-op when message is not cached', () => {
    const cache = emptyMessageListDataCache()

    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 999, userId: 5, emojiName: 'thumbs_up' }),
    )

    expect(getMessage(cache, msgId(999))).toBeUndefined()
  })

  test('deduplicate: adding the same reaction twice keeps one entry', () => {
    const cache = emptyMessageListDataCache()
    addEventMessage(cache, key, makeStreamMessage(1))

    const event = makeReactionEvent({ op: 'add', messageId: 1, userId: 5, emojiName: 'check' })
    applyReactionEvent(cache, event)
    applyReactionEvent(cache, event)

    const msg = getMessage(cache, msgId(1))
    expect(msg?.reactions).toHaveLength(1)
  })

  test('multiple users can react with the same emoji', () => {
    const cache = emptyMessageListDataCache()
    addEventMessage(cache, key, makeStreamMessage(1))

    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 5, emojiName: 'eyes' }),
    )
    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 6, emojiName: 'eyes' }),
    )

    const msg = getMessage(cache, msgId(1))
    expect(msg?.reactions).toHaveLength(2)
  })

  test('remove only removes matching user+emoji pair', () => {
    const cache = emptyMessageListDataCache()
    addEventMessage(cache, key, makeStreamMessage(1))

    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 5, emojiName: 'eyes' }),
    )
    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 6, emojiName: 'eyes' }),
    )
    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'remove', messageId: 1, userId: 5, emojiName: 'eyes' }),
    )

    const msg = getMessage(cache, msgId(1))
    expect(msg?.reactions).toEqual([{ emoji_name: emoji('eyes'), user_id: uid(6) }])
  })

  test('remove non-existent reaction is a no-op', () => {
    const cache = emptyMessageListDataCache()
    addEventMessage(cache, key, makeStreamMessage(1))

    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'remove', messageId: 1, userId: 5, emojiName: 'thumbs_up' }),
    )

    const msg = getMessage(cache, msgId(1))
    expect(msg?.reactions).toEqual([])
  })
})

describe('getReactions', () => {
  test('returns reactions for a cached message', () => {
    const cache = emptyMessageListDataCache()
    addEventMessage(cache, key, makeStreamMessage(1))
    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 5, emojiName: 'check' }),
    )

    expect(getReactions(cache, msgId(1))).toEqual([{ emoji_name: emoji('check'), user_id: uid(5) }])
  })

  test('returns empty array for uncached message', () => {
    const cache = emptyMessageListDataCache()
    expect(getReactions(cache, msgId(999))).toEqual([])
  })
})

describe('getReactionCount', () => {
  test('counts reactions with a specific emoji', () => {
    const cache = emptyMessageListDataCache()
    addEventMessage(cache, key, makeStreamMessage(1))
    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 5, emojiName: 'eyes' }),
    )
    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 6, emojiName: 'eyes' }),
    )
    applyReactionEvent(
      cache,
      makeReactionEvent({ op: 'add', messageId: 1, userId: 7, emojiName: 'check' }),
    )

    expect(getReactionCount(cache, msgId(1), emoji('eyes'))).toBe(2)
    expect(getReactionCount(cache, msgId(1), emoji('check'))).toBe(1)
    expect(getReactionCount(cache, msgId(1), emoji('thumbs_up'))).toBe(0)
  })

  test('returns 0 for uncached message', () => {
    const cache = emptyMessageListDataCache()
    expect(getReactionCount(cache, msgId(999), emoji('eyes'))).toBe(0)
  })
})
