import type { ZulipSession } from 'zulip-client-ts'
import type { StreamId, ZulipClient } from 'zulip-ts'
import { getStreams } from 'zulip-ts'

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
