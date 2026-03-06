import type { Kysely } from 'kysely'
import type { Message } from 'zulip-ts'
import type { ZulerDatabase } from './db.ts'
import { writeToInbox } from './inbox.ts'
import { addTopicSubscription, listTeammates, shouldReceive } from './state.ts'

type RouteResult = {
  readonly delivered: readonly {
    readonly teammate: string
    readonly from: string
  }[]
  readonly autoSubscribed: readonly {
    readonly teammate: string
    readonly stream: string
    readonly topic: string
  }[]
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s)

/** Build a reverse map of bot_email → teammate_name. */
async function buildEmailMap(db: Kysely<ZulerDatabase>): Promise<Map<string, string>> {
  const result = await listTeammates(db)
  if (result.isErr()) return new Map()
  return new Map(result.value.map((t) => [t.botEmail, t.name]))
}

/** Identify which teammate (if any) sent this message, so we don't echo it back. */
function identifySender(
  senderEmail: string,
  senderName: string,
  emailMap: Map<string, string>,
  allNames: Set<string>,
): string | undefined {
  const byEmail = emailMap.get(senderEmail)
  if (byEmail) return byEmail
  const lower = senderName.toLowerCase()
  if (allNames.has(lower)) return lower
  return undefined
}

/** Route a DM to the appropriate teammate(s). */
export async function routeDm(
  db: Kysely<ZulerDatabase>,
  teamName: string,
  message: Message,
): Promise<RouteResult> {
  const emailMap = await buildEmailMap(db)
  const recipients = message.display_recipient

  if (typeof recipients === 'string') {
    return { delivered: [], autoSubscribed: [] }
  }

  const senderName = message.sender_full_name
  const content = message.content
  const summary = truncate(content, 60)
  const recipientEmails = new Set(recipients.map((r) => r.email))
  const delivered: { teammate: string; from: string }[] = []

  for (const [email, name] of emailMap) {
    if (email === message.sender_email) continue
    if (recipientEmails.has(email)) {
      const from = `zulip:${senderName}`
      writeToInbox(teamName, name, from, content, summary)
      delivered.push({ teammate: name, from })
    }
  }

  return { delivered, autoSubscribed: [] }
}

/** Route a stream message to subscribed teammates, handling @-mentions and auto-subscribe. */
export async function routeStreamMessage(
  db: Kysely<ZulerDatabase>,
  teamName: string,
  message: Message,
): Promise<RouteResult> {
  if (typeof message.display_recipient !== 'string') {
    return { delivered: [], autoSubscribed: [] }
  }

  const stream = message.display_recipient
  const topic = message.subject ?? ''
  const content = message.content
  const senderName = message.sender_full_name
  const location = `${stream}/${topic}`
  const summary = truncate(content, 60)

  const teammatesResult = await listTeammates(db)
  if (teammatesResult.isErr()) {
    return { delivered: [], autoSubscribed: [] }
  }
  const teammates = teammatesResult.value
  const emailMap = new Map(teammates.map((t) => [t.botEmail, t.name]))
  const allNames = new Set(teammates.map((t) => t.name))

  const senderTeammate = identifySender(message.sender_email, senderName, emailMap, allNames)

  const recipientNames = new Set<string>()
  const autoSubscribed: { teammate: string; stream: string; topic: string }[] = []

  for (const name of allNames) {
    if (name === senderTeammate) continue

    const mention = `@**${name}**`
    const isMention = content.includes(mention)

    const subResult = await shouldReceive(db, name, stream, topic)
    const isSubscribed = subResult.isOk() && subResult.value

    if (isMention) {
      if (!isSubscribed) {
        await addTopicSubscription(db, name, stream, topic)
        autoSubscribed.push({ teammate: name, stream, topic })
      }
      recipientNames.add(name)
    } else if (isSubscribed) {
      recipientNames.add(name)
    }
  }

  const delivered: { teammate: string; from: string }[] = []
  for (const name of recipientNames) {
    const from = `zulip:${location}:${senderName}`
    writeToInbox(teamName, name, from, content, summary)
    delivered.push({ teammate: name, from })
  }

  return { delivered, autoSubscribed }
}

/** Route any inbound Zulip message (DM or stream) to the appropriate teammates. */
export async function routeMessage(
  db: Kysely<ZulerDatabase>,
  teamName: string,
  message: Message,
): Promise<RouteResult> {
  const isDm = Array.isArray(message.display_recipient)
  return isDm ? routeDm(db, teamName, message) : routeStreamMessage(db, teamName, message)
}

export type { RouteResult }
