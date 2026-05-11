import type { FollowedTopic, ZulipSession } from 'zulip-client-ts'
import type { NarrowFilter, StreamId, ZulipClient } from 'zulip-ts'
import { getStreams } from 'zulip-ts'

/** A group of narrow filters to fetch, with a log label and the individual filters. */
export type NarrowGroup = {
  readonly label: string
  readonly narrows: readonly (readonly NarrowFilter[])[]
}

export type FollowedNarrowGroups = {
  readonly groups: readonly NarrowGroup[]
  /** Number of channels covered by the topic narrows. */
  readonly channelCount: number
  /** Number of followed topics that produced narrows (excludes those skipped for no unreads). */
  readonly topicCount: number
  /** Number of followed topics skipped because they had no unreads (only nonzero in unreadOnly mode). */
  readonly skippedNoUnreads: number
}

export type BuildFollowedNarrowGroupsOptions = {
  /** When true, append `is:unread` to every narrow and filter topics/mentions/DMs by unread state. */
  readonly unreadOnly: boolean
  /**
   * Resolve a stream ID to its display name for use in group labels. When omitted, labels
   * fall back to `channel ${streamId}`. Callers that ignore labels (e.g. catch-up, which
   * only iterates the narrows) can leave this unset to skip the resolver setup.
   */
  readonly resolveChannelName?: (streamId: StreamId) => string | undefined
}

const UNREAD_FILTER: NarrowFilter = { operator: 'is', operand: 'unread' }
const MENTIONED_FILTER: NarrowFilter = { operator: 'is', operand: 'mentioned' }
const DM_FILTER: NarrowFilter = { operator: 'is', operand: 'dm' }

/**
 * Build narrow groups from a session's followed topics, plus mentions and DMs groups.
 *
 * When `unreadOnly` is true, each narrow includes `is:unread`; topics without unread messages
 * are skipped, and mentions/DMs groups are added only when their unread sets are non-empty.
 *
 * When `unreadOnly` is false, every followed topic produces a narrow regardless of unread
 * state, and mentions/DMs groups are always added.
 */
export function buildFollowedNarrowGroups(
  session: ZulipSession,
  options: BuildFollowedNarrowGroupsOptions,
): FollowedNarrowGroups {
  const { unreadOnly, resolveChannelName } = options

  const allFollowed = session.getFollowedTopics()
  const followed = unreadOnly
    ? allFollowed.filter((ft) => session.hasUnreads(ft.streamId, ft.topic))
    : allFollowed
  const skippedNoUnreads = allFollowed.length - followed.length

  const byChannel = Map.groupBy(followed, (ft) => ft.streamId)

  const channelGroups: NarrowGroup[] = [...byChannel.entries()].map(([streamId, topics]) => ({
    label: `${topics.length} topic(s) in ${resolveChannelName?.(streamId) ?? `channel ${streamId}`}`,
    narrows: topics.map((ft) => topicNarrow(ft, unreadOnly)),
  }))

  const extraGroups = [
    maybeExtraGroup('mentions', MENTIONED_FILTER, unreadOnly, () => session.hasAnyUnreadMentions()),
    maybeExtraGroup('DMs', DM_FILTER, unreadOnly, () => session.hasAnyUnreadDms()),
  ].filter((g): g is NarrowGroup => g !== undefined)

  return {
    groups: [...channelGroups, ...extraGroups],
    channelCount: byChannel.size,
    topicCount: followed.length,
    skippedNoUnreads,
  }
}

function topicNarrow(ft: FollowedTopic, unreadOnly: boolean): readonly NarrowFilter[] {
  return withUnread(
    [
      { operator: 'stream', operand: ft.streamId },
      { operator: 'topic', operand: ft.topic },
    ],
    unreadOnly,
  )
}

function maybeExtraGroup(
  label: string,
  baseFilter: NarrowFilter,
  unreadOnly: boolean,
  hasUnread: () => boolean,
): NarrowGroup | undefined {
  if (unreadOnly && !hasUnread()) return undefined
  return { label, narrows: [withUnread([baseFilter], unreadOnly)] }
}

function withUnread(base: readonly NarrowFilter[], unreadOnly: boolean): readonly NarrowFilter[] {
  return unreadOnly ? [...base, UNREAD_FILTER] : base
}

/**
 * Build a stream ID → channel name resolver. Uses the session's known subscriptions first,
 * then falls back to a `getStreams` lookup when any followed topics live in unsubscribed
 * channels. Returns a synchronous lookup function plus the side-effect of populating the
 * index from the API.
 *
 * The `onError` callback fires (without throwing) if the `getStreams` fallback fails —
 * the resolver will still work for streams covered by subscriptions.
 */
export async function buildChannelNameResolver(
  session: ZulipSession,
  client: ZulipClient,
  onError?: (message: string) => void,
): Promise<(streamId: StreamId) => string | undefined> {
  const index = new Map<StreamId, string>()
  for (const sub of session.getAllSubscriptions()) {
    index.set(sub.stream_id, sub.name)
  }

  const followed = session.getFollowedTopics()
  const hasUnresolved = followed.some((ft) => !index.has(ft.streamId))
  if (hasUnresolved) {
    const streamsResult = await getStreams(client)
    if (streamsResult.isOk()) {
      for (const stream of streamsResult.value.streams) {
        if (!index.has(stream.stream_id)) {
          index.set(stream.stream_id, stream.name)
        }
      }
    } else {
      onError?.(
        `getStreams failed for channel name resolution: ${JSON.stringify(streamsResult.error)}`,
      )
    }
  }

  return (streamId: StreamId) => index.get(streamId)
}
