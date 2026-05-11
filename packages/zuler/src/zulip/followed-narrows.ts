import type { FollowedTopic, ZulipSession } from 'zulip-client-ts'
import type { NarrowFilter, StreamId } from 'zulip-ts'

/** A group of narrow filters to fetch, with a log label and the individual filters. */
export type NarrowGroup = {
  readonly label: string
  readonly narrows: readonly (readonly NarrowFilter[])[]
}

/** Counts describing a session's followed-topic narrow set. */
export type FollowedNarrowCounts = {
  /** Number of followed topics that produced narrows (excludes those skipped for no unreads). */
  readonly topicCount: number
  /** Number of followed topics skipped because they had no unreads (only nonzero in unreadOnly mode). */
  readonly skippedNoUnreads: number
  /** Number of channels covered by the topic narrows. */
  readonly channelCount: number
}

export type FollowedNarrows = FollowedNarrowCounts & {
  readonly narrows: readonly (readonly NarrowFilter[])[]
}

export type FollowedNarrowGroups = FollowedNarrowCounts & {
  readonly groups: readonly NarrowGroup[]
}

export type BuildFollowedNarrowsOptions = {
  /** When true, append `is:unread` to every narrow and filter topics/mentions/DMs by unread state. */
  readonly unreadOnly: boolean
}

export type BuildFollowedNarrowGroupsOptions = BuildFollowedNarrowsOptions & {
  /** Resolve a stream ID to its display name for use in group labels. Falls back to `channel ${streamId}` when undefined or returns undefined. */
  readonly resolveChannelName: (streamId: StreamId) => string | undefined
}

const UNREAD_FILTER: NarrowFilter = { operator: 'is', operand: 'unread' }
const MENTIONED_FILTER: NarrowFilter = { operator: 'is', operand: 'mentioned' }
const DM_FILTER: NarrowFilter = { operator: 'is', operand: 'dm' }

/**
 * Build narrow filters for a session's followed topics, mentions, and DMs. Returns a flat
 * list of narrow filters suitable for `getMessages` calls — no labels, no per-channel
 * grouping. Use this when you just need to fan out fetches.
 *
 * When `unreadOnly` is true, each narrow includes `is:unread`; topics without unread
 * messages are skipped, and mentions/DMs narrows are added only when their unread sets are
 * non-empty.
 *
 * When `unreadOnly` is false, every followed topic produces a narrow regardless of unread
 * state, and mentions/DMs narrows are always added.
 */
export function buildFollowedNarrows(
  session: ZulipSession,
  options: BuildFollowedNarrowsOptions,
): FollowedNarrows {
  const { unreadOnly } = options
  const { followed, counts } = selectFollowedTopics(session, unreadOnly)

  const topicNarrows = followed.map((ft) => topicNarrow(ft, unreadOnly))
  const extraNarrows = collectExtraNarrows(session, unreadOnly)

  return {
    narrows: [...topicNarrows, ...extraNarrows],
    ...counts,
  }
}

/**
 * Build narrow groups (labeled, grouped by channel) for a session's followed topics,
 * mentions, and DMs. Used by backfill, which surfaces group labels in log output.
 *
 * Same filtering rules as `buildFollowedNarrows`; this function adds labels and per-channel
 * grouping on top.
 */
export function buildFollowedNarrowGroups(
  session: ZulipSession,
  options: BuildFollowedNarrowGroupsOptions,
): FollowedNarrowGroups {
  const { unreadOnly, resolveChannelName } = options
  const { followed, counts } = selectFollowedTopics(session, unreadOnly)

  const byChannel = Map.groupBy(followed, (ft) => ft.streamId)
  const channelGroups: NarrowGroup[] = [...byChannel.entries()].map(([streamId, topics]) => ({
    label: `${topics.length} topic(s) in ${resolveChannelName(streamId) ?? `channel ${streamId}`}`,
    narrows: topics.map((ft) => topicNarrow(ft, unreadOnly)),
  }))

  const extraGroups: NarrowGroup[] = []
  for (const [label, filter, hasUnread] of extraSources(session)) {
    const narrow = includeExtraNarrow(filter, unreadOnly, hasUnread)
    if (narrow) extraGroups.push({ label, narrows: [narrow] })
  }

  return {
    groups: [...channelGroups, ...extraGroups],
    ...counts,
  }
}

/** The mentions and DMs sources, ordered for consistent group/log output in backfill. */
function extraSources(
  session: ZulipSession,
): readonly (readonly [label: string, filter: NarrowFilter, hasUnread: () => boolean])[] {
  return [
    ['mentions', MENTIONED_FILTER, () => session.hasAnyUnreadMentions()],
    ['DMs', DM_FILTER, () => session.hasAnyUnreadDms()],
  ]
}

/**
 * Apply the followed-topic filter rule and compute shared counts. Single source of truth
 * for which topics produce narrows in both `buildFollowedNarrows` and `buildFollowedNarrowGroups`.
 */
function selectFollowedTopics(
  session: ZulipSession,
  unreadOnly: boolean,
): { readonly followed: readonly FollowedTopic[]; readonly counts: FollowedNarrowCounts } {
  const all = session.getFollowedTopics()
  const followed = unreadOnly ? all.filter((ft) => session.hasUnreads(ft.streamId, ft.topic)) : all
  const channelCount = new Set(followed.map((ft) => ft.streamId)).size
  return {
    followed,
    counts: {
      topicCount: followed.length,
      skippedNoUnreads: all.length - followed.length,
      channelCount,
    },
  }
}

function collectExtraNarrows(
  session: ZulipSession,
  unreadOnly: boolean,
): readonly (readonly NarrowFilter[])[] {
  const narrows: (readonly NarrowFilter[])[] = []
  for (const [, filter, hasUnread] of extraSources(session)) {
    const narrow = includeExtraNarrow(filter, unreadOnly, hasUnread)
    if (narrow) narrows.push(narrow)
  }
  return narrows
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

function includeExtraNarrow(
  baseFilter: NarrowFilter,
  unreadOnly: boolean,
  hasUnread: () => boolean,
): readonly NarrowFilter[] | undefined {
  if (unreadOnly && !hasUnread()) return undefined
  return withUnread([baseFilter], unreadOnly)
}

function withUnread(base: readonly NarrowFilter[], unreadOnly: boolean): readonly NarrowFilter[] {
  return unreadOnly ? [...base, UNREAD_FILTER] : base
}
