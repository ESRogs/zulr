import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import type { Member, Stream, StreamId, UserId, ZulipClient } from 'zulip-ts'
import { getMembers, getStreams } from 'zulip-ts'

export const NOT_CONFIGURED_MESSAGE = 'Zulip credentials not configured. Call the init tool first.'

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

type TimedCache<T> = {
  data: T
  fetchedAt: number
}

function isCacheValid<T>(cache: TimedCache<T> | null): cache is TimedCache<T> {
  return cache !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS
}

/**
 * Cached members and channels lookups backed by a Zulip admin client.
 * The admin client is resolved lazily via a callback, so credentials can
 * be loaded after the cache is created.
 */
export type CacheContext = {
  /** Get the members map (user_id -> Member), refreshing the cache if needed. */
  readonly getMembersMap: () => ResultAsync<ReadonlyMap<UserId, Member>, string>
  readonly invalidateMembersCache: () => void
  /** Resolve a user by ID, full name, or email. Returns the Member if found. */
  readonly resolveUser: (identifier: string | number) => ResultAsync<Member, string>
  /** List all channels (uses cache). */
  readonly listChannels: () => ResultAsync<readonly Stream[], string>
  /** Get the channels map (stream_id -> Stream), refreshing the cache if needed. */
  readonly getChannelsMap: () => ResultAsync<ReadonlyMap<StreamId, Stream>, string>
  readonly invalidateChannelsCache: () => void
  /** Resolve a channel name to a Stream object. */
  readonly resolveChannel: (name: string) => ResultAsync<Stream, string>
}

export function createCacheContext(getClient: () => ZulipClient | undefined): CacheContext {
  let membersCache: TimedCache<Map<UserId, Member>> | null = null
  let channelsCache: TimedCache<Map<StreamId, Stream>> | null = null

  function refreshMembersCache(): ResultAsync<Map<UserId, Member>, string> {
    const client = getClient()
    if (!client) return errAsync(NOT_CONFIGURED_MESSAGE)
    return getMembers(client)
      .map((res) => {
        const data = new Map(res.members.map((m) => [m.user_id, m]))
        membersCache = { data, fetchedAt: Date.now() }
        return data
      })
      .mapErr((err) => `failed to fetch Zulip members: ${JSON.stringify(err)}`)
  }

  function getMember(userId: UserId): ResultAsync<Member | undefined, string> {
    if (isCacheValid(membersCache)) {
      const cached = membersCache.data.get(userId)
      if (cached) return okAsync(cached)
    }
    return refreshMembersCache().andThen((cache) => okAsync(cache.get(userId)))
  }

  function refreshChannelsCache(): ResultAsync<Map<StreamId, Stream>, string> {
    const client = getClient()
    if (!client) return errAsync(NOT_CONFIGURED_MESSAGE)
    return getStreams(client)
      .map((res) => {
        const data = new Map(res.streams.map((s) => [s.stream_id, s]))
        channelsCache = { data, fetchedAt: Date.now() }
        return data
      })
      .mapErr((err) => `failed to fetch channels: ${JSON.stringify(err)}`)
  }

  return {
    getMembersMap: () => {
      if (isCacheValid(membersCache))
        return okAsync(membersCache.data as ReadonlyMap<UserId, Member>)
      return refreshMembersCache().map((data) => data as ReadonlyMap<UserId, Member>)
    },
    invalidateMembersCache: () => {
      membersCache = null
    },
    resolveUser: (identifier: string | number) => {
      const asNumber = typeof identifier === 'number' ? identifier : Number(identifier)
      if (Number.isInteger(asNumber) && asNumber > 0) {
        const id = asNumber as UserId
        return getMember(id).andThen((member) =>
          member ? okAsync(member) : errAsync(`unknown Zulip user ID: ${id}`),
        )
      }
      function findInCache(cache: Map<UserId, Member>): Member | undefined {
        for (const m of cache.values()) {
          if (
            m.full_name === identifier ||
            m.email === identifier ||
            m.delivery_email === identifier
          )
            return m
        }
        return undefined
      }
      if (isCacheValid(membersCache)) {
        const found = findInCache(membersCache.data)
        if (found) return okAsync(found)
      }
      return refreshMembersCache().andThen((cache) => {
        const found = findInCache(cache)
        if (found) return okAsync(found)
        return errAsync(`no Zulip user found matching "${identifier}"`)
      })
    },
    listChannels: () => {
      if (isCacheValid(channelsCache)) return okAsync([...channelsCache.data.values()])
      return refreshChannelsCache().map((data) => [...data.values()])
    },
    getChannelsMap: () => {
      if (isCacheValid(channelsCache))
        return okAsync(channelsCache.data as ReadonlyMap<StreamId, Stream>)
      return refreshChannelsCache().map((data) => data as ReadonlyMap<StreamId, Stream>)
    },
    invalidateChannelsCache: () => {
      channelsCache = null
    },
    resolveChannel: (name: string) => {
      function findInCache(cache: Map<StreamId, Stream>): Stream | undefined {
        for (const s of cache.values()) {
          if (s.name === name) return s
        }
        return undefined
      }
      if (isCacheValid(channelsCache)) {
        const found = findInCache(channelsCache.data)
        if (found) return okAsync(found)
      }
      return refreshChannelsCache().andThen((cache) => {
        const found = findInCache(cache)
        if (found) return okAsync(found)
        return errAsync(`channel "${name}" not found`)
      })
    },
  }
}
