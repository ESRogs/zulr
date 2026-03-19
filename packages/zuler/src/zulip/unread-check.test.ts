import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MessageId, UserId } from 'zulip-ts'
import {
  consumeUnreadDmMessages,
  consumeUnreadInboxMessages,
  readInbox,
  writeToInbox,
} from './inbox.ts'
import {
  checkUnreadBeforeDm,
  checkUnreadBeforePost,
  countUnreadDmsFromUser,
  countUnreadFromTopic,
} from './unread-check.ts'

let teamName: string

beforeEach(() => {
  teamName = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`
})

afterEach(() => {
  rmSync(join(homedir(), '.claude', 'teams', teamName), { recursive: true, force: true })
})

test('returns 0 when inbox does not exist', () => {
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(0)
})

test('returns 0 when no unread messages from that topic', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:other-stream/other-topic:Bob',
    text: 'hello',
    summary: 'hello',
    zulipStream: 'other-stream',
    zulipTopic: 'other-topic',
    zulipSender: 'Bob',
  })
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(0)
})

test('counts unread messages from matching topic', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
    zulipStream: 'general',
    zulipTopic: 'greetings',
    zulipSender: 'Bob',
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Charlie',
    text: 'msg2',
    summary: 'msg2',
    zulipStream: 'general',
    zulipTopic: 'greetings',
    zulipSender: 'Charlie',
  })
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(2)
})

test('ignores messages from different topics in same stream', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
    zulipStream: 'general',
    zulipTopic: 'greetings',
    zulipSender: 'Bob',
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/other:Bob',
    text: 'msg2',
    summary: 'msg2',
    zulipStream: 'general',
    zulipTopic: 'other',
    zulipSender: 'Bob',
  })
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(1)
})

test('uses exact matching for stream and topic names', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:General/Greetings:Bob',
    text: 'msg',
    summary: 'msg',
    zulipStream: 'General',
    zulipTopic: 'Greetings',
    zulipSender: 'Bob',
  })
  expect(countUnreadFromTopic(teamName, 'alice', 'General', 'Greetings')).toBe(1)
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(0)
})

test('ignores non-zulip messages', () => {
  writeToInbox(teamName, 'alice', { from: 'teammate-bob', text: 'hello', summary: 'hello' })
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(0)
})

test('checkUnreadBeforePost returns error when unread', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'msg',
    summary: 'msg',
    zulipStream: 'general',
    zulipTopic: 'greetings',
    zulipSender: 'Bob',
  })
  const result = checkUnreadBeforePost(teamName, 'alice', 'general', 'greetings')
  expect(result).toContain('1 unread message(s)')
  expect(result).toContain('general/greetings')
})

test('checkUnreadBeforePost returns undefined when no unread', () => {
  const result = checkUnreadBeforePost(teamName, 'alice', 'general', 'greetings')
  expect(result).toBeUndefined()
})

// --- consumeUnreadInboxMessages tests ---

test('consumeUnreadInboxMessages marks matching messages and returns them', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
    zulipStream: 'general',
    zulipTopic: 'greetings',
    zulipSender: 'Bob',
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/other:Bob',
    text: 'msg2',
    summary: 'msg2',
    zulipStream: 'general',
    zulipTopic: 'other',
    zulipSender: 'Bob',
  })

  const consumed = consumeUnreadInboxMessages(teamName, 'alice', 'general', 'greetings')

  expect(consumed).toHaveLength(1)
  expect(consumed[0]!.text).toBe('msg1')
  const inbox = readInbox(teamName, 'alice')
  expect(inbox[0]!.read).toBe(true)
  expect(inbox[1]!.read).toBe(false)
})

test('consumeUnreadInboxMessages leaves messages without structured fields alone', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'legacy msg',
    summary: 'legacy',
  })

  const consumed = consumeUnreadInboxMessages(teamName, 'alice', 'general', 'greetings')

  expect(consumed).toHaveLength(0)
  const inbox = readInbox(teamName, 'alice')
  expect(inbox[0]!.read).toBe(false)
})

// --- DM unread check tests ---

test('countUnreadDmsFromUser returns 0 when inbox does not exist', () => {
  expect(countUnreadDmsFromUser(teamName, 'alice', 42 as UserId)).toBe(0)
})

test('countUnreadDmsFromUser counts DMs from matching sender', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:Bob',
    text: 'dm1',
    summary: 'dm1',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: 'Bob',
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:Bob',
    text: 'dm2',
    summary: 'dm2',
    zulipMessageId: 101 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: 'Bob',
  })
  expect(countUnreadDmsFromUser(teamName, 'alice', 42 as UserId)).toBe(2)
})

test('countUnreadDmsFromUser ignores DMs from other senders', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:Bob',
    text: 'dm from bob',
    summary: 'dm',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: 'Bob',
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:Charlie',
    text: 'dm from charlie',
    summary: 'dm',
    zulipMessageId: 101 as MessageId,
    zulipSenderId: 99 as UserId,
    zulipSender: 'Charlie',
  })
  expect(countUnreadDmsFromUser(teamName, 'alice', 42 as UserId)).toBe(1)
})

test('countUnreadDmsFromUser ignores stream messages from same sender', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'stream msg',
    summary: 'stream msg',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipStream: 'general',
    zulipTopic: 'greetings',
    zulipSender: 'Bob',
  })
  expect(countUnreadDmsFromUser(teamName, 'alice', 42 as UserId)).toBe(0)
})

test('checkUnreadBeforeDm returns error when unread DMs exist', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:Bob',
    text: 'dm',
    summary: 'dm',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: 'Bob',
  })
  const result = checkUnreadBeforeDm(teamName, 'alice', 42 as UserId)
  expect(result).toContain('1 unread DM(s)')
  expect(result).toContain('user 42')
})

test('checkUnreadBeforeDm returns undefined when no unread DMs', () => {
  const result = checkUnreadBeforeDm(teamName, 'alice', 42 as UserId)
  expect(result).toBeUndefined()
})

test('consumeUnreadDmMessages marks matching DMs and returns them', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:Bob',
    text: 'dm from bob',
    summary: 'dm',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: 'Bob',
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:Charlie',
    text: 'dm from charlie',
    summary: 'dm',
    zulipMessageId: 101 as MessageId,
    zulipSenderId: 99 as UserId,
    zulipSender: 'Charlie',
  })

  const consumed = consumeUnreadDmMessages(teamName, 'alice', 42 as UserId)

  expect(consumed).toHaveLength(1)
  expect(consumed[0]!.text).toBe('dm from bob')
  const inbox = readInbox(teamName, 'alice')
  expect(inbox[0]!.read).toBe(true)
  expect(inbox[1]!.read).toBe(false)
})

test('consumeUnreadDmMessages unblocks checkUnreadBeforeDm', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:Bob',
    text: 'dm',
    summary: 'dm',
    zulipMessageId: 100 as MessageId,
    zulipSenderId: 42 as UserId,
    zulipSender: 'Bob',
  })

  expect(checkUnreadBeforeDm(teamName, 'alice', 42 as UserId)).toBeDefined()
  consumeUnreadDmMessages(teamName, 'alice', 42 as UserId)
  expect(checkUnreadBeforeDm(teamName, 'alice', 42 as UserId)).toBeUndefined()
})
