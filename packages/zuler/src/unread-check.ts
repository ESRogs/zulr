import { readInbox } from './inbox.ts'

/**
 * Count unread inbound messages from a specific stream/topic in a
 * teammate's Claude Code inbox.
 *
 * Inbound stream messages have a `from` field like:
 *   "zulip:<stream>/<topic>:<sender>"
 *
 * Uses exact matching for stream/topic names since Zulip treats
 * topics as case-sensitive.
 */
export function countUnreadFromTopic(
  teamName: string,
  teammate: string,
  stream: string,
  topic: string,
): number {
  const messages = readInbox(teamName, teammate)
  const prefix = `zulip:${stream}/${topic}:`

  let count = 0
  for (const msg of messages) {
    if (msg.read) continue
    if (msg.from.startsWith(prefix)) {
      count++
    }
  }
  return count
}

/**
 * Check whether a teammate is allowed to post to a stream/topic.
 * Returns an error message if blocked, or undefined if allowed.
 */
export function checkUnreadBeforePost(
  teamName: string,
  sender: string,
  stream: string,
  topic: string,
): string | undefined {
  const unread = countUnreadFromTopic(teamName, sender, stream, topic)
  if (unread > 0) {
    return `you have ${unread} unread message(s) from ${stream}/${topic} in your inbox. Read them before posting.`
  }
  return undefined
}
