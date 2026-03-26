import type { ChannelName, StreamId, TopicName, ZulipClient } from 'zulip-ts'
import { setUserTopic, subscribe, TopicVisibility } from 'zulip-ts'

/**
 * Subscribe the bot to a channel (if not already subscribed) and follow a topic.
 *
 * Zulip only delivers stream message events for subscribed channels, so following
 * a topic without a subscription has no effect on event delivery. This function
 * ensures both are in place.
 *
 * Subscribe is idempotent — calling it when already subscribed is a no-op.
 */
export function subscribeAndFollow(
  client: ZulipClient,
  channel: ChannelName,
  streamId: StreamId,
  topic: TopicName,
) {
  return subscribe(client, [{ name: channel }]).andThen(() =>
    setUserTopic(client, streamId, topic, TopicVisibility.FOLLOWED),
  )
}
