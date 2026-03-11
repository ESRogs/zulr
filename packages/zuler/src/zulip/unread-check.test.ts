import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { consumeUnreadInboxMessages, readInbox, writeToInbox } from './inbox.ts'
import { checkUnreadBeforePost, countUnreadFromTopic } from './unread-check.ts'

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
