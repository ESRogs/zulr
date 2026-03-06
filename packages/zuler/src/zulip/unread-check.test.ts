import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeToInbox } from './inbox.ts'
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
  writeToInbox(teamName, 'alice', 'zulip:other-stream/other-topic:Bob', 'hello', 'hello')
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(0)
})

test('counts unread messages from matching topic', () => {
  writeToInbox(teamName, 'alice', 'zulip:general/greetings:Bob', 'msg1', 'msg1')
  writeToInbox(teamName, 'alice', 'zulip:general/greetings:Charlie', 'msg2', 'msg2')
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(2)
})

test('ignores messages from different topics in same stream', () => {
  writeToInbox(teamName, 'alice', 'zulip:general/greetings:Bob', 'msg1', 'msg1')
  writeToInbox(teamName, 'alice', 'zulip:general/other:Bob', 'msg2', 'msg2')
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(1)
})

test('uses exact matching for stream and topic names', () => {
  writeToInbox(teamName, 'alice', 'zulip:General/Greetings:Bob', 'msg', 'msg')
  expect(countUnreadFromTopic(teamName, 'alice', 'General', 'Greetings')).toBe(1)
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(0)
})

test('ignores non-zulip messages', () => {
  writeToInbox(teamName, 'alice', 'teammate-bob', 'hello', 'hello')
  expect(countUnreadFromTopic(teamName, 'alice', 'general', 'greetings')).toBe(0)
})

test('checkUnreadBeforePost returns error when unread', () => {
  writeToInbox(teamName, 'alice', 'zulip:general/greetings:Bob', 'msg', 'msg')
  const result = checkUnreadBeforePost(teamName, 'alice', 'general', 'greetings')
  expect(result).toContain('1 unread message(s)')
  expect(result).toContain('general/greetings')
})

test('checkUnreadBeforePost returns undefined when no unread', () => {
  const result = checkUnreadBeforePost(teamName, 'alice', 'general', 'greetings')
  expect(result).toBeUndefined()
})
