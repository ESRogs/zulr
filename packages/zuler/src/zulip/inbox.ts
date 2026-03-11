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

/** Resolve the inbox directory for a given team name. */
export function inboxDir(teamName: string): string {
  return join(homedir(), '.claude', 'teams', teamName, 'inboxes')
}

/** Resolve the inbox file path for a teammate within a team. */
export function inboxPath(teamName: string, teammate: string): string {
  return join(inboxDir(teamName), `${teammate}.json`)
}

/** Read all messages from a teammate's inbox file. */
export function readInbox(teamName: string, teammate: string): readonly InboxMessage[] {
  const path = inboxPath(teamName, teammate)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as InboxMessage[]
  } catch {
    return []
  }
}

/** Append a message to a teammate's inbox file. */
export function writeToInbox(
  teamName: string,
  teammate: string,
  from: string,
  text: string,
  summary: string,
  zulipMessageId?: number,
): void {
  const dir = inboxDir(teamName)
  mkdirSync(dir, { recursive: true })

  const path = inboxPath(teamName, teammate)
  const messages: InboxMessage[] = existsSync(path)
    ? (() => {
        try {
          return JSON.parse(readFileSync(path, 'utf-8')) as InboxMessage[]
        } catch {
          return []
        }
      })()
    : []

  messages.push({
    from,
    text,
    summary,
    timestamp: new Date().toISOString(),
    read: false,
    ...(zulipMessageId !== undefined ? { zulipMessageId } : {}),
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
  if (!existsSync(path)) return 0
  try {
    const messages = JSON.parse(readFileSync(path, 'utf-8')) as InboxMessage[]
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
  } catch {
    return 0
  }
}

export type { InboxMessage }
