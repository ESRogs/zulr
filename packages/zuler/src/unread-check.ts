import { readInbox } from './inbox.ts'

/** Normalize a stream or topic name for comparison. */
const normalize = (name: string): string =>
  name.trim().replace(/[\s_-]+/g, '-').toLowerCase()

/**
 * Count unread inbound messages from a specific stream/topic in a
 * teammate's Claude Code inbox.
 *
 * Inbound stream messages have a `from` field like:
 *   "zulip:<sender> in <stream>/<topic>"
 *
 * This matches that pattern and compares the normalized stream/topic.
 */
export const countUnreadFromTopic = (
  teamName: string,
  teammate: string,
  stream: string,
  topic: string,
): number => {
  const messages = readInbox(teamName, teammate)
  const target = `${normalize(stream)}/${normalize(topic)}`

  let count = 0
  for (const msg of messages) {
    if (msg.read) continue
    const match = msg.from.match(/^zulip:.+ in (.+)$/i)
    if (match?.[1] && normalize(match[1]).startsWith(target)) {
      count++
    }
  }
  return count
}

/**
 * Check whether a teammate is allowed to post to a stream/topic.
 * Returns an error message if blocked, or undefined if allowed.
 */
export const checkUnreadBeforePost = (
  teamName: string,
  sender: string,
  stream: string,
  topic: string,
): string | undefined => {
  const unread = countUnreadFromTopic(teamName, sender, stream, topic)
  if (unread > 0) {
    return `you have ${unread} unread message(s) from ${stream}/${topic} in your inbox. Read them before posting.`
  }
  return undefined
}
