import type { Kysely } from 'kysely'
import type { ResultAsync } from 'neverthrow'
import type { DmMessage, Email, MessageId, UnixEpochSeconds } from 'zulip-ts'
import type { ZulrDatabase } from '../state/db.ts'
import { listTeammates, type StateError } from '../state/teammates.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { writeToInbox } from './inbox.ts'
import { formatMessageFooter } from './message-reader.ts'

type RouteResult = {
  readonly messageId: MessageId
  readonly delivered: readonly {
    readonly teammate: TeammateName
    readonly from: string
  }[]
}

export const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s)

/** Replace straight double quotes with curly quotes (straight quotes break Claude Code UI display). */
export function sanitizeSummary(s: string): string {
  let open = true
  return s.replaceAll('"', () => {
    const q = open ? '\u201c' : '\u201d'
    open = !open
    return q
  })
}

function appendFooter(content: string, messageId: MessageId, timestamp: UnixEpochSeconds): string {
  return `${content}\n${formatMessageFooter(messageId, timestamp)}`
}

/**
 * Route a DM to a specific bot (per-bot listener mode) or to all recipient bots.
 * When targetBot is provided, only delivers to that bot.
 */
export function routeDm(
  db: Kysely<ZulrDatabase>,
  teamName: TeamName,
  message: DmMessage,
  targetBot?: TeammateName,
): ResultAsync<RouteResult, StateError> {
  return listTeammates(db).map((teammates) => {
    const emailMap = new Map<Email, TeammateName>(teammates.map((t) => [t.botEmail, t.name]))
    const senderName = message.sender_full_name
    const content = message.content
    const summary = sanitizeSummary(truncate(content, 60))
    const recipientEmails = new Set(message.display_recipient.map((r) => r.email))

    const delivered = [...emailMap]
      .filter(([email, name]) => {
        if (email === message.sender_email) return false
        if (!recipientEmails.has(email)) return false
        if (targetBot && name !== targetBot) return false
        return true
      })
      .flatMap(([_, name]) => {
        const from = `zulip:${senderName}`
        const writeResult = writeToInbox(teamName, name, {
          from,
          text: appendFooter(content, message.id, message.timestamp),
          summary,
          zulipMessageId: message.id,
          zulipSenderId: message.sender_id,
          zulipSender: senderName,
        })
        if (writeResult.isErr()) return []
        return [{ teammate: name, from }]
      })

    return { messageId: message.id, delivered }
  })
}

export type { RouteResult }
