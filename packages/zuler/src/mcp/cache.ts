import { errAsync, okAsync, type ResultAsync } from 'neverthrow'
import type { Member, Stream, UserId, ZulipClient } from 'zulip-ts'
import { getMembers, getStreams } from 'zulip-ts'

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
  /** Check whether a user ID belongs to a bot. */
  readonly isBot: (userId: UserId) => ResultAsync<boolean, string>
  /** List all channels (uses cache). */
  readonly listChannels: () => ResultAsync<readonly Stream[], string>
  readonly invalidateChannelsCache: () => void
  /** Resolve a channel name to a Stream object. */
  readonly resolveChannel: (name: string) => ResultAsync<Stream, string>
}

export function createCacheContext(
  getClient: () => ZulipClient | undefined,
  notConfiguredMessage: string,
): CacheContext {
  let membersCache: TimedCache<Map<UserId, Member>> | null = null
  let channelsCache: TimedCache<readonly Stream[]> | null = null

  function refreshMembersCache(): ResultAsync<Map<UserId, Member>, string> {
    const client = getClient()
    if (!client) return errAsync(notConfiguredMessage)
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

  function refreshChannelsCache(): ResultAsync<readonly Stream[], string> {
    const client = getClient()
    if (!client) return errAsync(notConfiguredMessage)
    return getStreams(client)
      .map((res) => {
        channelsCache = { data: res.streams, fetchedAt: Date.now() }
        return res.streams
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
    isBot: (userId: UserId) => {
      return getMember(userId).andThen((member) => {
        if (!member) return errAsync(`unknown Zulip user ID: ${userId}`)
        return okAsync(member.is_bot ?? false)
      })
    },
    listChannels: () => {
      if (isCacheValid(channelsCache)) return okAsync(channelsCache.data)
      return refreshChannelsCache()
    },
    invalidateChannelsCache: () => {
      channelsCache = null
    },
    resolveChannel: (name: string) => {
      function findInList(streams: readonly Stream[]): Stream | undefined {
        return streams.find((s) => s.name === name)
      }
      if (isCacheValid(channelsCache)) {
        const found = findInList(channelsCache.data)
        if (found) return okAsync(found)
      }
      return refreshChannelsCache().andThen((streams) => {
        const found = findInList(streams)
        if (found) return okAsync(found)
        return errAsync(`channel "${name}" not found`)
      })
    },
  }
}
