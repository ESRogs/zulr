# Stateful Zulip Client Design

## Motivation

Zuler currently treats the Zulip API as a request-response service: each MCP tool call makes fresh API requests, and the event listener is a simple message forwarder. This creates several problems:

1. **Inbox flooding**: The per-bot event listener delivers ALL messages from subscribed channels to the Claude Code inbox, even when the bot isn't following the topic and wasn't mentioned. Agents get overwhelmed with irrelevant messages.

2. **No unread awareness at post time**: The old unread-check system relied on the Claude Code inbox (blocking posts if there were unconsumed inbox messages). With inbox delivery now tied to Zulip subscriptions, this check doesn't work for topics where the bot is subscribed but not following — messages arrive via events but aren't in the inbox, so there's nothing to check against.

3. **Redundant API calls**: Every `read`, `catch-up`, or `search` call hits the Zulip API directly. The event listener already receives all messages but discards them after writing to the inbox.

4. **No notification intelligence**: The system can't distinguish between "you were @-mentioned" and "someone posted in a channel you happen to be subscribed to."

## Proposed Architecture

### Three-layer package structure

```
zulip-ts          — Stateless API wrapper (exists today)
zulip-client-ts   — Stateful per-user Zulip client (new)
zuler             — MCP server + Claude Code integration (exists, uses the above)
```

### `zulip-client-ts`: Per-user stateful client

Each registered bot gets one `ZulipSession` instance that manages:

**Event queue + long-poll loop**
- Registers with `message`, `update_message_flags`, `update_message`, `reaction`, and `user_topic` event types
- Initial state from `register` includes `unread_msgs` (message IDs grouped by stream/topic)
- Long-polls for events and updates local state

**Local state**
- **Unread map**: `Map<"streamId:topic", Set<messageId>>` — updated on `message` events (add) and `update_message_flags` events (remove when read flag added)
- **Topic visibility**: `Map<"streamId:topic", VisibilityPolicy>` — updated from `user_topic` events. Values: 0=inherit, 1=muted, 2=unmuted, 3=followed
- **Members cache**: `Map<userId, Member>` — populated from initial state, updated on `realm_user` events
- **Subscriptions**: channel list from initial state, updated on `subscription` events

**Notification trigger evaluation**

For each incoming message event, determine if it's notification-worthy:
- DM → always notify
- `mentioned` or `wildcard_mentioned` in message flags → notify
- Topic visibility is FOLLOWED (3) → notify
- Otherwise → silent (update unread state only)

**Query interface**

```ts
type ZulipSession = {
  // Unread state
  getUnreadCount(streamId: number, topic: string): number
  getUnreadMessageIds(streamId: number, topic: string): readonly number[]
  hasUnreads(streamId: number, topic: string): boolean

  // Topic state
  getTopicVisibility(streamId: number, topic: string): VisibilityPolicy
  isFollowed(streamId: number, topic: string): boolean

  // Notification check
  shouldNotify(message: Message): boolean

  // Members
  resolveUserId(id: number): string | undefined
  resolveName(name: string): Member | undefined

  // Lifecycle
  start(): Promise<void>
  stop(): void
}
```

### Changes to `zuler`

**Inbox delivery**: The event listener uses `session.shouldNotify(message)` to decide whether to write to the Claude Code inbox. Non-notification messages still update the session's unread state silently.

**`reply` tool** (new): Posts to a channel/topic, but first checks `session.hasUnreads(streamId, topic)`. If unreads exist, returns an error with context:
```
You have 5 unread messages in general/project-update (oldest: 2h ago).
Use `read` to catch up, or use `post` to skip this check.
```

**`post` tool** (modified): Posts without any unread check. For new threads or when the agent has context and doesn't need to catch up.

**`topic-state` tool** (new): Returns a summary of the bot's state for a topic:
```
general/project-update
  Unread: 5 messages (oldest: 2h ago, newest: 10m ago)
  Your last message: 3h ago
  Following: yes
```

**`read` tool**: Can optionally query local state instead of hitting the Zulip API when recent messages are cached.

**`catch-up` tool**: Uses `session.getSubscriptions()` and unread state to prioritize which topics to fetch.

## Implementation Plan

### Step 1: `zulip-client-ts` package with unread tracking

Create the new package with `ZulipSession`:
- Event queue lifecycle (register, long-poll, reconnect)
- `unread_msgs` from initial state
- Update unreads on `message` and `update_message_flags` events
- `getUnreadCount`, `hasUnreads`, `getUnreadMessageIds` query methods
- Tests with mock event streams

New zulip-ts API additions:
- Update `registerQueue` to accept `fetch_event_types` and return `unread_msgs` in initial state
- Parse the `unread_msgs` structure (streams, DMs, mentions)

### Step 2: Topic visibility tracking + notification logic

Add to `ZulipSession`:
- Track `user_topic` events for follow/mute state
- `shouldNotify(message)` evaluating: DM, mentions (from flags), followed topic
- `getTopicVisibility`, `isFollowed` query methods
- Tests for notification trigger logic

### Step 3: Integrate with zuler event listener

Replace the current "deliver everything to inbox" with:
- Create `ZulipSession` per bot in `EventListenerManager`
- Use `shouldNotify` to filter inbox delivery
- Non-notification messages update session state silently
- Remove `automatically_follow_topics_where_mentioned` default from registration

### Step 4: `reply` and `topic-state` tools

- `reply` tool: checks `session.hasUnreads()` before posting
- `topic-state` tool: queries session for unread count, visibility, last activity
- Rename or update `post` tool description to clarify it skips unread checks

### Step 5: Local read optimization (optional)

- Cache recent messages from events in the session
- `read` tool can serve from cache when data is fresh
- Reduces API calls for frequently-read topics

## Design Decisions

**Per-bot sessions, no shared state**: Each bot maintains independent state. Simpler than shared caching with permission checks. Can optimize later.

**Notification triggers match Zulip's model**: DMs, @-mentions, followed topics. Replicates the same logic the Zulip web client uses for desktop notifications. No custom notification preferences for now — can add later if needed.

**`reply` vs `post` instead of `force` param**: Separate tools with clear semantics are more discoverable than a boolean flag. Agents naturally reach for `reply` in conversation and `post` for announcements.

**Unread state is Zulip-native**: Tracked via Zulip's own unread_msgs + event updates. No custom SQLite tables or inbox-based approximations.
