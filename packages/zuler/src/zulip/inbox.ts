import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FormattedMessage } from './message-reader.ts'

type InboxMessage = {
  readonly from: string
  readonly text: string
  readonly summary: string
  readonly timestamp: string
  readonly read: boolean
  readonly zulipMessageId?: number
  readonly zulipSenderId?: number
  readonly zulipStream?: string
  readonly zulipTopic?: string
  readonly zulipSender?: string
}

type InboxEntry = {
  readonly from: string
  readonly text: string
  readonly summary: string
  readonly zulipMessageId?: number
  readonly zulipSenderId?: number
  readonly zulipStream?: string
  readonly zulipTopic?: string
  readonly zulipSender?: string
}

/** Resolve the inbox directory for a given team name. */
export function inboxDir(teamName: string): string {
  return join(homedir(), '.claude', 'teams', teamName, 'inboxes')
}

/** Resolve the inbox file path for a teammate within a team. */
export function inboxPath(teamName: string, teammate: string): string {
  return join(inboxDir(teamName), `${teammate}.json`)
}

/** Load and parse an inbox file, returning empty array on missing/corrupt file. */
function loadInbox(path: string): InboxMessage[] {
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as InboxMessage[]
  } catch {
    return []
  }
}

/** Read all messages from a teammate's inbox file. */
export function readInbox(teamName: string, teammate: string): readonly InboxMessage[] {
  return loadInbox(inboxPath(teamName, teammate))
}

/** Append a message to a teammate's inbox file. */
export function writeToInbox(teamName: string, teammate: string, entry: InboxEntry): void {
  const dir = inboxDir(teamName)
  mkdirSync(dir, { recursive: true })

  const path = inboxPath(teamName, teammate)
  const messages = loadInbox(path)

  messages.push({
    ...entry,
    timestamp: new Date().toISOString(),
    read: false,
  })

  writeFileSync(path, JSON.stringify(messages, null, 2))
}

/** Consume (mark as read and return) unread inbox messages matching a predicate. */
function consumeMatching(
  path: string,
  predicate: (m: InboxMessage) => boolean,
): readonly InboxMessage[] {
  const messages = loadInbox(path)
  if (messages.length === 0) return []

  const consumed: InboxMessage[] = []
  const updated = messages.map((m) => {
    if (!m.read && predicate(m)) {
      consumed.push(m)
      return { ...m, read: true }
    }
    return m
  })
  if (consumed.length > 0) {
    writeFileSync(path, JSON.stringify(updated, null, 2))
  }
  return consumed
}

/** Consume unread inbox messages matching a stream/topic. */
export function consumeUnreadInboxMessages(
  teamName: string,
  teammate: string,
  stream: string,
  topic: string,
): readonly InboxMessage[] {
  return consumeMatching(
    inboxPath(teamName, teammate),
    (m) => m.zulipStream === stream && m.zulipTopic === topic,
  )
}

/** Consume all unread inbox messages from Zulip stream sources (not DMs). */
export function consumeAllUnreadInboxMessages(
  teamName: string,
  teammate: string,
): readonly InboxMessage[] {
  return consumeMatching(inboxPath(teamName, teammate), (m) => !!m.zulipStream)
}

/** Convert inbox messages to FormattedMessage for merging with Zulip API results. */
export function inboxToFormattedMessages(messages: readonly InboxMessage[]): FormattedMessage[] {
  return messages.flatMap((m) => {
    // Only convert messages with structured fields — skip legacy messages
    if (!m.zulipStream || !m.zulipTopic || !m.zulipSender) return []
    return [
      {
        id: m.zulipMessageId ?? -(Date.parse(m.timestamp) || 0),
        stream: m.zulipStream,
        topic: m.zulipTopic,
        sender: m.zulipSender,
        content: m.text,
        timestamp: (Date.parse(m.timestamp) || 0) / 1000,
      },
    ]
  })
}

/** Merge Zulip messages with inbox-only messages, deduplicating by ID. */
export function mergeWithInbox(
  zulipMessages: readonly FormattedMessage[],
  inboxMessages: readonly FormattedMessage[],
): FormattedMessage[] {
  const zulipIds = new Set(zulipMessages.map((m) => m.id))
  const inboxOnly = inboxMessages.filter((m) => m.id < 0 || !zulipIds.has(m.id))
  return [...zulipMessages, ...inboxOnly]
}

export type { InboxMessage, InboxEntry }
