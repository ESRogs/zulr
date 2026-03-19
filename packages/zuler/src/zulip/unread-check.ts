import type { ChannelName, TopicName, UserId } from 'zulip-ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { readInbox } from './inbox.ts'

/**
 * Count unread inbound messages from a specific stream/topic in a
 * teammate's Claude Code inbox. Matches on the structured
 * zulipStream and zulipTopic fields (case-sensitive).
 */
export function countUnreadFromTopic(
  teamName: TeamName,
  teammate: TeammateName,
  stream: ChannelName,
  topic: TopicName,
): number {
  const messages = readInbox(teamName, teammate)
  return messages.filter(
    (msg) => !msg.read && msg.zulipStream === stream && msg.zulipTopic === topic,
  ).length
}

/**
 * Count unread DMs from a specific user in a teammate's inbox.
 * Matches on the zulipSenderId field.
 */
export function countUnreadDmsFromUser(
  teamName: TeamName,
  teammate: TeammateName,
  fromUserId: UserId,
): number {
  const messages = readInbox(teamName, teammate)
  return messages.filter((msg) => !msg.read && !msg.zulipStream && msg.zulipSenderId === fromUserId)
    .length
}

/**
 * Check whether a teammate is allowed to post to a stream/topic.
 * Returns an error message if blocked, or undefined if allowed.
 */
export function checkUnreadBeforePost(
  teamName: TeamName,
  sender: TeammateName,
  stream: ChannelName,
  topic: TopicName,
): string | undefined {
  const unread = countUnreadFromTopic(teamName, sender, stream, topic)
  if (unread > 0) {
    return `you have ${unread} unread message(s) in ${stream}/${topic}. Use the read or catch-up tool first.`
  }
  return undefined
}

/**
 * Check whether a teammate is allowed to DM a user.
 * Returns an error message if blocked, or undefined if allowed.
 */
export function checkUnreadBeforeDm(
  teamName: TeamName,
  sender: TeammateName,
  fromUserId: UserId,
): string | undefined {
  const unread = countUnreadDmsFromUser(teamName, sender, fromUserId)
  if (unread > 0) {
    return `you have ${unread} unread DM(s) from user ${fromUserId}. Use the read or catch-up tool first.`
  }
  return undefined
}
