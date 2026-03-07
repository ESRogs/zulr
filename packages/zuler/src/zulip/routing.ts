import type { Kysely } from 'kysely'
import type { DmMessage, Message, StreamMessage } from 'zulip-ts'
import type { ZulerDatabase } from '../state/db.ts'
import { addTopicSubscription, shouldReceive } from '../state/subscriptions.ts'
import { listTeammates } from '../state/teammates.ts'
import { writeToInbox } from './inbox.ts'

type RouteResult = {
  readonly messageId: number
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
  message: DmMessage,
): Promise<RouteResult> {
  const emailMap = await buildEmailMap(db)
  const senderName = message.sender_full_name
  const content = message.content
  const summary = truncate(content, 60)
  const recipientEmails = new Set(message.display_recipient.map((r) => r.email))

  const delivered = [...emailMap]
    .filter(([email]) => email !== message.sender_email && recipientEmails.has(email))
    .map(([_, name]) => {
      const from = `zulip:${senderName}`
      writeToInbox(teamName, name, from, content, summary)
      return { teammate: name, from }
    })

  return { messageId: message.id, delivered, autoSubscribed: [] }
}

/** Route a stream message to subscribed teammates, handling @-mentions and auto-subscribe. */
export async function routeStreamMessage(
  db: Kysely<ZulerDatabase>,
  teamName: string,
  message: StreamMessage,
): Promise<RouteResult> {
  const stream = message.display_recipient
  const topic = message.subject
  const content = message.content
  const senderName = message.sender_full_name
  const location = `${stream}/${topic}`
  const summary = truncate(content, 60)

  const teammatesResult = await listTeammates(db)
  if (teammatesResult.isErr()) {
    return { messageId: message.id, delivered: [], autoSubscribed: [] }
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

  const delivered = [...recipientNames].map((name) => {
    const from = `zulip:${location}:${senderName}`
    writeToInbox(teamName, name, from, content, summary)
    return { teammate: name, from }
  })

  return { messageId: message.id, delivered, autoSubscribed }
}

/** Route any inbound Zulip message (DM or stream) to the appropriate teammates. */
export async function routeMessage(
  db: Kysely<ZulerDatabase>,
  teamName: string,
  message: Message,
): Promise<RouteResult> {
  if (message.type === 'private') {
    return routeDm(db, teamName, message)
  }
  return routeStreamMessage(db, teamName, message)
}

export type { RouteResult }
