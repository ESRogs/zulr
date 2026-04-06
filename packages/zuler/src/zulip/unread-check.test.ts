import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChannelName, DisplayName, MessageId, TopicName, UserId } from 'zulip-ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import {
  consumeUnreadDmMessages,
  consumeUnreadInboxMessages,
  readInbox,
  writeToInbox,
} from './inbox.ts'
import { checkUnreadBeforeDm, checkUnreadBeforePost } from './unread-check.ts'

let teamName: TeamName

// Short casts for readability
const tm = (s: string) => s as TeammateName
const ch = (s: string) => s as ChannelName
const tp = (s: string) => s as TopicName
const dn = (s: string) => s as DisplayName

beforeEach(() => {
  teamName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}` as TeamName
})

afterEach(() => {
  rmSync(join(homedir(), '.claude', 'teams', teamName), { recursive: true, force: true })
})

test('checkUnreadBeforePost returns undefined when inbox does not exist', () => {
  expect(
    checkUnreadBeforePost(teamName, tm('alice'), ch('general'), tp('greetings')),
  ).toBeUndefined()
})

test('checkUnreadBeforePost returns undefined when no unread messages from that topic', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:other-stream/other-topic:Bob',
    text: 'hello',
    summary: 'hello',
    zulipStream: ch('other-stream'),
    zulipTopic: tp('other-topic'),
    zulipSender: dn('Bob'),
  })
  expect(
    checkUnreadBeforePost(teamName, tm('alice'), ch('general'), tp('greetings')),
  ).toBeUndefined()
})

test('checkUnreadBeforePost returns error when unread messages exist', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
    zulipStream: ch('general'),
    zulipTopic: tp('greetings'),
    zulipSender: dn('Bob'),
  })
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/greetings:Charlie',
    text: 'msg2',
    summary: 'msg2',
    zulipStream: ch('general'),
    zulipTopic: tp('greetings'),
    zulipSender: dn('Charlie'),
  })
  const result = checkUnreadBeforePost(teamName, tm('alice'), ch('general'), tp('greetings'))
  expect(result).toContain('2 unread message(s)')
  expect(result).toContain('general/greetings')
})

test('checkUnreadBeforePost ignores messages from different topics in same stream', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
    zulipStream: ch('general'),
    zulipTopic: tp('greetings'),
    zulipSender: dn('Bob'),
  })
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/other:Bob',
    text: 'msg2',
    summary: 'msg2',
    zulipStream: ch('general'),
    zulipTopic: tp('other'),
    zulipSender: dn('Bob'),
  })
  const result = checkUnreadBeforePost(teamName, tm('alice'), ch('general'), tp('greetings'))
  expect(result).toContain('1 unread message(s)')
})

test('checkUnreadBeforePost uses exact matching for stream and topic names', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:General/Greetings:Bob',
    text: 'msg',
    summary: 'msg',
    zulipStream: ch('General'),
    zulipTopic: tp('Greetings'),
    zulipSender: dn('Bob'),
  })
  expect(checkUnreadBeforePost(teamName, tm('alice'), ch('General'), tp('Greetings'))).toBeDefined()
  expect(
    checkUnreadBeforePost(teamName, tm('alice'), ch('general'), tp('greetings')),
  ).toBeUndefined()
})

test('checkUnreadBeforePost ignores non-zulip messages', () => {
  writeToInbox(teamName, tm('alice'), { from: 'teammate-bob', text: 'hello', summary: 'hello' })
  expect(
    checkUnreadBeforePost(teamName, tm('alice'), ch('general'), tp('greetings')),
  ).toBeUndefined()
})

test('checkUnreadBeforePost returns undefined when no unread', () => {
  const result = checkUnreadBeforePost(teamName, tm('alice'), ch('general'), tp('greetings'))
  expect(result).toBeUndefined()
})

// --- consumeUnreadInboxMessages tests ---

test('consumeUnreadInboxMessages marks matching messages and returns them', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
    zulipStream: ch('general'),
    zulipTopic: tp('greetings'),
    zulipSender: dn('Bob'),
  })
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/other:Bob',
    text: 'msg2',
    summary: 'msg2',
    zulipStream: ch('general'),
    zulipTopic: tp('other'),
    zulipSender: dn('Bob'),
  })

  const consumed = consumeUnreadInboxMessages(
    teamName,
    tm('alice'),
    ch('general'),
    tp('greetings'),
  )._unsafeUnwrap()

  expect(consumed).toHaveLength(1)
  expect(consumed[0]!.text).toBe('msg1')
  const inbox = readInbox(teamName, tm('alice'))._unsafeUnwrap()
  expect(inbox[0]!.read).toBe(true)
  expect(inbox[1]!.read).toBe(false)
})

test('consumeUnreadInboxMessages leaves messages without structured fields alone', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/greetings:Bob',
    text: 'legacy msg',
    summary: 'legacy',
  })

  const consumed = consumeUnreadInboxMessages(
    teamName,
    tm('alice'),
    ch('general'),
    tp('greetings'),
  )._unsafeUnwrap()

  expect(consumed).toHaveLength(0)
  const inbox = readInbox(teamName, tm('alice'))._unsafeUnwrap()
  expect(inbox[0]!.read).toBe(false)
})

// --- DM unread check tests ---

test('checkUnreadBeforeDm returns undefined when inbox does not exist', () => {
  expect(checkUnreadBeforeDm(teamName, tm('alice'), 42 as UserId)).toBeUndefined()
})

test('checkUnreadBeforeDm returns error when DMs from matching sender exist', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:Bob',
    text: 'dm1',
    summary: 'dm1',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: dn('Bob'),
  })
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:Bob',
    text: 'dm2',
    summary: 'dm2',
    zulipMessageId: 101 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: dn('Bob'),
  })
  const result = checkUnreadBeforeDm(teamName, tm('alice'), 42 as UserId)
  expect(result).toContain('2 unread DM(s)')
})

test('checkUnreadBeforeDm ignores DMs from other senders', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:Bob',
    text: 'dm from bob',
    summary: 'dm',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: dn('Bob'),
  })
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:Charlie',
    text: 'dm from charlie',
    summary: 'dm',
    zulipMessageId: 101 as MessageId,
    zulipSenderId: 99 as UserId,
    zulipSender: dn('Charlie'),
  })
  const result = checkUnreadBeforeDm(teamName, tm('alice'), 42 as UserId)
  expect(result).toContain('1 unread DM(s)')
})

test('checkUnreadBeforeDm ignores stream messages from same sender', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/greetings:Bob',
    text: 'stream msg',
    summary: 'stream msg',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipStream: ch('general'),
    zulipTopic: tp('greetings'),
    zulipSender: dn('Bob'),
  })
  expect(checkUnreadBeforeDm(teamName, tm('alice'), 42 as UserId)).toBeUndefined()
})

test('checkUnreadBeforeDm returns error when unread DMs exist', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:Bob',
    text: 'dm',
    summary: 'dm',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: dn('Bob'),
  })
  const result = checkUnreadBeforeDm(teamName, tm('alice'), 42 as UserId)
  expect(result).toContain('1 unread DM(s)')
  expect(result).toContain('user 42')
})

test('checkUnreadBeforeDm returns undefined when no unread DMs', () => {
  const result = checkUnreadBeforeDm(teamName, tm('alice'), 42 as UserId)
  expect(result).toBeUndefined()
})

test('consumeUnreadDmMessages marks matching DMs and returns them', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:Bob',
    text: 'dm from bob',
    summary: 'dm',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: dn('Bob'),
  })
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:Charlie',
    text: 'dm from charlie',
    summary: 'dm',
    zulipMessageId: 101 as MessageId,
    zulipSenderId: 99 as UserId,
    zulipSender: dn('Charlie'),
  })

  const consumed = consumeUnreadDmMessages(teamName, tm('alice'), 42 as UserId)._unsafeUnwrap()

  expect(consumed).toHaveLength(1)
  expect(consumed[0]!.text).toBe('dm from bob')
  const inbox = readInbox(teamName, tm('alice'))._unsafeUnwrap()
  expect(inbox[0]!.read).toBe(true)
  expect(inbox[1]!.read).toBe(false)
})

// --- writeToInbox dedup tests ---

test('writeToInbox skips duplicate zulipMessageId', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipStream: ch('general'),
    zulipTopic: tp('greetings'),
    zulipSender: dn('Bob'),
  })
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1 duplicate',
    summary: 'msg1 duplicate',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipStream: ch('general'),
    zulipTopic: tp('greetings'),
    zulipSender: dn('Bob'),
  })
  const inbox = readInbox(teamName, tm('alice'))._unsafeUnwrap()
  expect(inbox).toHaveLength(1)
  expect(inbox[0]!.text).toBe('msg1')
})

test('writeToInbox allows messages without zulipMessageId (non-Zulip messages)', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zuler:system',
    text: 'system msg 1',
    summary: 'system',
  })
  writeToInbox(teamName, tm('alice'), {
    from: 'zuler:system',
    text: 'system msg 2',
    summary: 'system',
  })
  const inbox = readInbox(teamName, tm('alice'))._unsafeUnwrap()
  expect(inbox).toHaveLength(2)
})

test('consumeUnreadDmMessages unblocks checkUnreadBeforeDm', () => {
  writeToInbox(teamName, tm('alice'), {
    from: 'zulip:Bob',
    text: 'dm',
    summary: 'dm',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: dn('Bob'),
  })

  expect(checkUnreadBeforeDm(teamName, tm('alice'), 42 as UserId)).toBeDefined()
  consumeUnreadDmMessages(teamName, tm('alice'), 42 as UserId)._unsafeUnwrap()
  expect(checkUnreadBeforeDm(teamName, tm('alice'), 42 as UserId)).toBeUndefined()
})
