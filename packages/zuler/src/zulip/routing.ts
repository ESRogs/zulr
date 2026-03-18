import type { Kysely } from 'kysely'
import type { DmMessage } from 'zulip-ts'
import type { ZulerDatabase } from '../state/db.ts'
import { listTeammates } from '../state/teammates.ts'
import { writeToInbox } from './inbox.ts'
import { formatMessageFooter } from './message-reader.ts'

type RouteResult = {
  readonly messageId: number
  readonly delivered: readonly {
    readonly teammate: string
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

function appendFooter(content: string, messageId: number, timestamp: number): string {
  return `${content}\n${formatMessageFooter(messageId, timestamp)}`
}

/** Build a reverse map of bot_email → teammate_name. */
async function buildEmailMap(db: Kysely<ZulerDatabase>): Promise<Map<string, string>> {
  const result = await listTeammates(db)
  if (result.isErr()) return new Map()
  return new Map(result.value.map((t) => [t.botEmail, t.name]))
}

/**
 * Route a DM to a specific bot (per-bot listener mode) or to all recipient bots.
 * When targetBot is provided, only delivers to that bot.
 */
export async function routeDm(
  db: Kysely<ZulerDatabase>,
  teamName: string,
  message: DmMessage,
  targetBot?: string,
): Promise<RouteResult> {
  const emailMap = await buildEmailMap(db)
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
    .map(([_, name]) => {
      const from = `zulip:${senderName}`
      writeToInbox(teamName, name, {
        from,
        text: appendFooter(content, message.id, message.timestamp),
        summary,
        zulipMessageId: message.id,
        zulipSenderId: message.sender_id,
        zulipSender: senderName,
      })
      return { teammate: name, from }
    })

  return { messageId: message.id, delivered }
}

export type { RouteResult }
