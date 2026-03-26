import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelName, TopicName, UserId } from 'zulip-ts'
import { stateDir } from '../state/db.ts'
import type { TeammateName, TeamName } from '../tagged-types.ts'
import { type InboxMessage, readInbox } from './inbox.ts'

function debugLog(msg: string): void {
  const repoRoot = process.env.ZULER_REPO_ROOT ?? process.cwd()
  const logFile = join(stateDir(repoRoot), 'zuler.log')
  const line = `[${new Date().toISOString()}] [unread-check] ${msg}\n`
  try {
    appendFileSync(logFile, line)
  } catch {
    // Silently ignore if log file isn't writable
  }
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
  const messages = readInbox(teamName, sender)
  const unread = countUnreadFromTopic(messages, stream, topic)

  // Debug logging to diagnose unread gate bypass
  const unreadMessages = messages.filter((msg) => !msg.read)
  const topicMatches = messages.filter(
    (msg) => !msg.read && msg.zulipStream === stream && msg.zulipTopic === topic,
  )
  debugLog(
    `checkUnreadBeforePost: sender=${sender} target=${stream}/${topic} ` +
      `total=${messages.length} unread=${unreadMessages.length} topicMatch=${topicMatches.length}`,
  )
  if (unreadMessages.length > 0) {
    for (const msg of unreadMessages) {
      debugLog(
        `  unread: stream=${msg.zulipStream ?? '(dm)'} topic=${msg.zulipTopic ?? '(none)'} ` +
          `from=${msg.from} read=${msg.read}`,
      )
    }
  }

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
  const messages = readInbox(teamName, sender)
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
