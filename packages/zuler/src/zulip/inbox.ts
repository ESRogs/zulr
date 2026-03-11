import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type InboxMessage = {
  readonly from: string
  readonly text: string
  readonly summary: string
  readonly timestamp: string
  readonly read: boolean
  readonly zulipMessageId?: number
}

type InboxEntry = {
  readonly from: string
  readonly text: string
  readonly summary: string
  readonly zulipMessageId?: number
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

/**
 * Mark specific inbox messages as read by their Zulip message IDs.
 * Returns the number of messages marked.
 */
export function markInboxMessagesByIdAsRead(
  teamName: string,
  teammate: string,
  messageIds: readonly number[],
): number {
  const path = inboxPath(teamName, teammate)
  const messages = loadInbox(path)
  if (messages.length === 0) return 0

  const idSet = new Set(messageIds)
  let marked = 0
  const updated = messages.map((m) => {
    if (!m.read && m.zulipMessageId !== undefined && idSet.has(m.zulipMessageId)) {
      marked++
      return { ...m, read: true }
    }
    return m
  })
  if (marked > 0) {
    writeFileSync(path, JSON.stringify(updated, null, 2))
  }
  return marked
}

export type { InboxMessage, InboxEntry }
