import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

type InboxMessage = {
  readonly from: string
  readonly text: string
  readonly summary: string
  readonly timestamp: string
  readonly read: boolean
}

/** Resolve the inbox directory for a given team name. */
export const inboxDir = (teamName: string): string =>
  join(homedir(), '.claude', 'teams', teamName, 'inboxes')

/** Resolve the inbox file path for a teammate within a team. */
export const inboxPath = (teamName: string, teammate: string): string =>
  join(inboxDir(teamName), `${teammate}.json`)

/** Read all messages from a teammate's inbox file. */
export const readInbox = (teamName: string, teammate: string): readonly InboxMessage[] => {
  const path = inboxPath(teamName, teammate)
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as InboxMessage[]
  } catch {
    return []
  }
}

/** Append a message to a teammate's inbox file. */
export const writeToInbox = (
  teamName: string,
  teammate: string,
  from: string,
  text: string,
  summary: string,
): void => {
  const dir = inboxDir(teamName)
  mkdirSync(dir, { recursive: true })

  const path = inboxPath(teamName, teammate)
  const messages: InboxMessage[] = existsSync(path)
    ? (() => {
        try { return JSON.parse(readFileSync(path, 'utf-8')) as InboxMessage[] }
        catch { return [] }
      })()
    : []

  messages.push({
    from,
    text,
    summary,
    timestamp: new Date().toISOString().replace('+00:00', 'Z'),
    read: false,
  })

  writeFileSync(path, JSON.stringify(messages, null, 2))
}

export type { InboxMessage }
