import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { err, ok, type Result } from 'neverthrow'
import type {
  ChannelName,
  DisplayName,
  MessageId,
  TopicName,
  UnixEpochSeconds,
  UserId,
} from 'zulip-ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { type FormattedMessage, stripMessageFooter } from './message-reader.ts'

type InboxMessage = {
  readonly from: string
  readonly text: string
  readonly summary: string
  readonly timestamp: string
  readonly read: boolean
  readonly zulipMessageId?: MessageId
  readonly zulipSenderId?: UserId
  readonly zulipStream?: ChannelName
  readonly zulipTopic?: TopicName
  readonly zulipSender?: DisplayName
}

type InboxEntry = Omit<InboxMessage, 'timestamp' | 'read'>

/** Resolve the inbox directory for a given team name. */
export function inboxDir(teamName: TeamName): string {
  return join(homedir(), '.claude', 'teams', teamName, 'inboxes')
}

/** Resolve the inbox file path for a teammate within a team. */
export function inboxPath(teamName: TeamName, teammate: TeammateName): string {
  return join(inboxDir(teamName), `${teammate}.json`)
}

/** Load and parse an inbox file. Returns ok([]) for missing files, err for read/parse failures. */
function loadInbox(path: string): Result<InboxMessage[], string> {
  if (!existsSync(path)) return ok([])
  try {
    return ok(JSON.parse(readFileSync(path, 'utf-8')) as InboxMessage[])
  } catch (e) {
    return err(`failed to read inbox at ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Read all messages from a teammate's inbox file. */
export function readInbox(
  teamName: TeamName,
  teammate: TeammateName,
): Result<readonly InboxMessage[], string> {
  return loadInbox(inboxPath(teamName, teammate))
}

/** Append a message to a teammate's inbox file. */
export function writeToInbox(
  teamName: TeamName,
  teammate: TeammateName,
  entry: InboxEntry,
): Result<void, string> {
  const dir = inboxDir(teamName)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return err(`failed to create inbox dir ${dir}: ${e instanceof Error ? e.message : String(e)}`)
  }

  const path = inboxPath(teamName, teammate)
  const loadResult = loadInbox(path)
  if (loadResult.isErr()) return loadResult
  const messages = loadResult.value

  // Skip duplicate Zulip messages (prevents races between backfill and event listener)
  if (
    entry.zulipMessageId !== undefined &&
    messages.some((m) => m.zulipMessageId === entry.zulipMessageId)
  ) {
    return ok(undefined)
  }

  messages.push({
    ...entry,
    timestamp: new Date().toISOString(),
    read: false,
  })

  return writeInboxFile(path, messages)
}

/** Write an inbox message array to disk. */
function writeInboxFile(path: string, messages: readonly InboxMessage[]): Result<void, string> {
  try {
    writeFileSync(path, JSON.stringify(messages, null, 2))
    return ok(undefined)
  } catch (e) {
    return err(`failed to write inbox at ${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Consume (mark as read and return) unread inbox messages matching a predicate. */
function consumeMatching(
  path: string,
  predicate: (m: InboxMessage) => boolean,
): Result<readonly InboxMessage[], string> {
  const loadResult = loadInbox(path)
  if (loadResult.isErr()) return loadResult
  const messages = loadResult.value
  if (messages.length === 0) return ok([])

  const consumed: InboxMessage[] = []
  const updated = messages.map((m) => {
    if (!m.read && predicate(m)) {
      consumed.push(m)
      return { ...m, read: true }
    }
    return m
  })
  if (consumed.length > 0) {
    const writeResult = writeInboxFile(path, updated)
    if (writeResult.isErr()) return writeResult
  }
  return ok(consumed)
}

/** Consume unread inbox messages matching a stream/topic. */
export function consumeUnreadInboxMessages(
  teamName: TeamName,
  teammate: TeammateName,
  stream: ChannelName,
  topic: TopicName,
): Result<readonly InboxMessage[], string> {
  return consumeMatching(
    inboxPath(teamName, teammate),
    (m) => m.zulipStream === stream && m.zulipTopic === topic,
  )
}

/** Consume all unread inbox messages from Zulip stream sources (not DMs). */
export function consumeAllUnreadStreamMessages(
  teamName: TeamName,
  teammate: TeammateName,
): Result<readonly InboxMessage[], string> {
  return consumeMatching(inboxPath(teamName, teammate), (m) => !!m.zulipStream)
}

/** Consume unread DMs from a specific user in a teammate's inbox. */
export function consumeUnreadDmMessages(
  teamName: TeamName,
  teammate: TeammateName,
  fromUserId: UserId,
): Result<readonly InboxMessage[], string> {
  return consumeMatching(
    inboxPath(teamName, teammate),
    (m) => !m.zulipStream && m.zulipSenderId === fromUserId,
  )
}

/** Consume all unread DMs in a teammate's inbox (any sender). */
export function consumeAllUnreadDmMessages(
  teamName: TeamName,
  teammate: TeammateName,
): Result<readonly InboxMessage[], string> {
  return consumeMatching(
    inboxPath(teamName, teammate),
    (m) => !m.zulipStream && m.zulipSenderId !== undefined,
  )
}

/** Convert inbox messages to FormattedMessage for merging with Zulip API results. */
export function inboxToFormattedMessages(messages: readonly InboxMessage[]): FormattedMessage[] {
  return messages.flatMap((m): FormattedMessage[] => {
    if (!m.zulipSender) return []
    const id = (m.zulipMessageId ?? -(Date.parse(m.timestamp) || 0)) as MessageId
    const timestamp = ((Date.parse(m.timestamp) || 0) / 1000) as UnixEpochSeconds
    const shared = {
      id,
      sender: m.zulipSender,
      content: stripMessageFooter(m.text),
      timestamp,
    }

    if (m.zulipStream && m.zulipTopic) {
      return [{ ...shared, type: 'stream' as const, stream: m.zulipStream, topic: m.zulipTopic }]
    }
    if (m.zulipSenderId !== undefined) {
      // Inbox only contains inbound messages, so zulipSender is the other party.
      // isGroupDm can't be determined from inbox data (no participant list);
      // group DMs are not routed to inbox by the event listener.
      return [{ ...shared, type: 'dm' as const, dmWith: m.zulipSender as string, isGroupDm: false }]
    }
    return []
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

/** Consume all unread messages in a teammate's inbox. */
export function consumeAllUnreadMessages(
  teamName: TeamName,
  teammate: TeammateName,
): Result<readonly InboxMessage[], string> {
  return consumeMatching(inboxPath(teamName, teammate), () => true)
}

export type { InboxEntry, InboxMessage }
