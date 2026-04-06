import type { ChannelName, TopicName, UserId } from 'zulip-ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { type InboxMessage, readInbox } from './inbox.ts'

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
  const messages = readInbox(teamName, sender).unwrapOr([])
  const unread = countUnreadFromTopic(messages, stream, topic)
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
  const messages = readInbox(teamName, sender).unwrapOr([])
  const unread = countUnreadDmsFromUser(messages, fromUserId)
  if (unread > 0) {
    return `you have ${unread} unread DM(s) from user ${fromUserId}. Use the read or catch-up tool first.`
  }
  return undefined
}

function countUnreadFromTopic(
  messages: readonly InboxMessage[],
  stream: ChannelName,
  topic: TopicName,
): number {
  return messages.filter(
    (msg) => !msg.read && msg.zulipStream === stream && msg.zulipTopic === topic,
  ).length
}

function countUnreadDmsFromUser(messages: readonly InboxMessage[], fromUserId: UserId): number {
  return messages.filter((msg) => !msg.read && !msg.zulipStream && msg.zulipSenderId === fromUserId)
    .length
}
