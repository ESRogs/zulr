import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { markInboxMessagesByIdAsRead, readInbox, writeToInbox } from './inbox.ts'
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
  })
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(0)
})

test('counts unread messages from matching topic', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Charlie',
    text: 'msg2',
    summary: 'msg2',
  })
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(2)
})

test('ignores messages from different topics in same stream', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/other:Bob',
    text: 'msg2',
    summary: 'msg2',
  })
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(1)
})

test('uses exact matching for stream and topic names', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:General/Greetings:Bob',
    text: 'msg',
    summary: 'msg',
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
  })
  const result = checkUnreadBeforePost(teamName, 'alice', 'general', 'greetings')
  expect(result).toContain('1 unread message(s)')
  expect(result).toContain('general/greetings')
})

test('checkUnreadBeforePost returns undefined when no unread', () => {
  const result = checkUnreadBeforePost(teamName, 'alice', 'general', 'greetings')
  expect(result).toBeUndefined()
})

// --- markInboxMessagesByIdAsRead tests ---

test('marks matching messages as read by zulipMessageId', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'msg1',
    summary: 'msg1',
    zulipMessageId: 101,
  })
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Charlie',
    text: 'msg2',
    summary: 'msg2',
    zulipMessageId: 102,
  })

  const marked = markInboxMessagesByIdAsRead(teamName, 'alice', [101])

  expect(marked).toBe(1)
  const inbox = readInbox(teamName, 'alice')
  expect(inbox[0]!.read).toBe(true)
  expect(inbox[1]!.read).toBe(false)
})

test('does not mark messages without zulipMessageId', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'old msg',
    summary: 'old msg',
  })

  const marked = markInboxMessagesByIdAsRead(teamName, 'alice', [999])

  expect(marked).toBe(0)
  const inbox = readInbox(teamName, 'alice')
  expect(inbox[0]!.read).toBe(false)
})

test('does not re-mark already read messages', () => {
  writeToInbox(teamName, 'alice', {
    from: 'zulip:general/greetings:Bob',
    text: 'msg',
    summary: 'msg',
    zulipMessageId: 101,
  })
  markInboxMessagesByIdAsRead(teamName, 'alice', [101])
  const marked = markInboxMessagesByIdAsRead(teamName, 'alice', [101])
  expect(marked).toBe(0)
})

test('markInboxMessagesByIdAsRead returns 0 when inbox does not exist', () => {
  const marked = markInboxMessagesByIdAsRead(teamName, 'nobody', [101])
  expect(marked).toBe(0)
})
