# Stateful Zulip Client Design

## Motivation

Zulr currently treats the Zulip API as a request-response service: each MCP tool call makes fresh API requests, and the event listener is a simple message forwarder. This creates several problems:

1. **Inbox flooding**: The per-bot event listener delivers ALL messages from all public channels (via `all_public_streams`) to the Claude Code inbox, even when the bot isn't following the topic and wasn't mentioned. Agents get overwhelmed with irrelevant messages.

2. **No unread awareness at post time**: The old unread-check system relied on the Claude Code inbox (blocking posts if there were unconsumed inbox messages). With bots receiving all public channel events via `all_public_streams`, this check doesn't work for topics where the bot receives events but isn't following — messages arrive via events but aren't in the inbox, so there's nothing to check against.

3. **Redundant API calls**: Every `read`, `catch-up`, or `search` call hits the Zulip API directly. The event listener already receives all messages but discards them after writing to the inbox.

4. **No notification intelligence**: The system can't distinguish between "you were @-mentioned" and "someone posted in a channel you receive events from."

## Conventions

`zulip-client-ts` follows the same conventions as the rest of the monorepo:

- **`neverthrow`** Result/ResultAsync for error handling — errors are values, not exceptions
- **`zod`** for schema validation at external boundaries (Zulip API responses, event payloads)
- **`type-fest` Tagged** for opaque types — already in place via PR #61. Numeric IDs: `UserId`, `MessageId`, `StreamId`, `EventId`, `UnixEpochSeconds`. String types: `ChannelName`, `TopicName`, `Email`, `DisplayName`, `EmojiName`, `QueueId`, `ApiKey`. Zulr-specific: `TeammateName`, `TeamName`.
- **Functional style** with standalone functions, not classes. Imperative loops when clearer (e.g. event processing with side effects)
- **No database** — `zulip-client-ts` is pure in-memory state, no Kysely or SQLite
- **No web server** — it's a library consumed by `zulr`, not a standalone service

## Proposed Architecture

### Three-layer package structure

```
zulip-ts          — Stateless API wrapper (exists today)
zulip-client-ts   — Stateful per-user Zulip client (new)
zulr             — MCP server + Claude Code integration (exists, uses the above)
```

### `zulip-client-ts`: Per-user stateful client

Each registered bot gets one `ZulipSession` instance that manages:

**Event queue + long-poll loop**
- Registers with `message`, `update_message_flags`, `update_message`, `reaction`, `user_topic`, and `realm_user` event types
- Initial state from `register` includes `unread_msgs` (message IDs grouped by stream/topic)
- Long-polls for events and updates local state
- On queue expiration (BAD_EVENT_QUEUE_ID), re-registers and fully resets local state from the new initial state. Events during the re-register gap are recovered via the fresh `unread_msgs` snapshot.

**Local state**
- **Unread map (streams)**: `Map<StreamId, Map<TopicName, Set<MessageId>>>` — nested structure avoids composite-key ambiguity (topic names can contain colons). Updated on `message` events (add) and `update_message_flags` events (remove when read flag added).
- **Unread map (DMs)**: `Map<UserId, Set<MessageId>>` — same update pattern, from the `pms` section of `unread_msgs`
- **Topic visibility**: `Map<StreamId, Map<TopicName, VisibilityPolicy>>` — updated from `user_topic` events. Values: 0=inherit, 1=muted, 2=unmuted, 3=followed
- **Members cache**: `Map<UserId, Member>` — populated via `getMembers` API call on start (not included in `registerQueue` initial state), updated on `realm_user` events
- **Channels**: bots receive events from all public channels via `all_public_streams` — no per-channel subscription management needed

**Notification trigger evaluation**

For each incoming message event, determine if it's notification-worthy:
- DM → always notify
- `mentioned` or `wildcard_mentioned` in message flags → notify
- Topic visibility is FOLLOWED (3) → notify
- Otherwise → silent (update unread state only)

**Query interface**

```ts
type ZulipSession = {
  // Unread state (streams)
  getUnreadCount(streamId: StreamId, topic: TopicName): number
  getUnreadMessageIds(streamId: StreamId, topic: TopicName): readonly MessageId[]
  hasUnreads(streamId: StreamId, topic: TopicName): boolean

  // Unread state (DMs)
  getUnreadDmCount(userId: UserId): number
  hasUnreadDms(userId: UserId): boolean

  // Topic state
  getTopicVisibility(streamId: StreamId, topic: TopicName): VisibilityPolicy
  isFollowed(streamId: StreamId, topic: TopicName): boolean

  // Notification check
  shouldNotify(message: Message): boolean

  // Members
  resolveUserId(id: UserId): DisplayName | undefined
  resolveName(name: DisplayName): Member | undefined

  // Lifecycle
  start(): Promise<void>
  stop(): void
}
```

`ZulipSession.start()` owns the event loop — it replaces the current `runBotListener` function in zulr's event-listener.ts. The `EventListenerManager` in zulr becomes a session manager: it creates and starts `ZulipSession` instances instead of running event loops directly.

### Changes to `zulr`

**Inbox delivery**: The session calls a `zulr`-provided callback when a notification-worthy message arrives. `zulr` writes it to the Claude Code inbox. Non-notification messages update the session's unread state silently — no inbox write.

**`reply` tool** (new): Posts to a channel/topic or DM, but first checks `session.hasUnreads(streamId, topic)` (or `session.hasUnreadDms(userId)` for DMs). If unreads exist, returns an error with context:
```
You have 5 unread messages in general/project-update.
Use `read` or `catch-up` to catch up first, or use `post` to skip this check.
```

The check covers ALL unreads in the topic. Agents use `post` when they want to skip the check (e.g. the "days later" case where accumulated unreads aren't relevant, or when replying to a busy channel for the first time).

**`post` tool** (modified): Posts without any unread check. For new threads or when the agent has context and doesn't need to catch up.

**`topic-state` tool** (new): Returns a summary of the bot's state for a topic:
```
general/project-update
  Unread: 5 messages (oldest: msg #12345, newest: msg #12350)
  Following: yes
```
Unread count and visibility come from local session state. Additional context (like the bot's last message timestamp) can be added later via API call if needed — keeping the initial version simple with only locally-tracked state.

**`read` tool**: Can optionally query local state instead of hitting the Zulip API when recent messages are cached.

**`catch-up` tool**: Uses unread state to prioritize which topics to fetch.

## Implementation Plan

### Step 1: `zulip-client-ts` package with unread tracking

Create the new package with `ZulipSession`:
- Event queue lifecycle (register, long-poll, reconnect with full state reset)
- `unread_msgs` from initial state (streams + DMs + mentions)
- Update unreads on `message` and `update_message_flags` events
- `getUnreadCount`, `hasUnreads`, `getUnreadMessageIds`, `getUnreadDmCount`, `hasUnreadDms` query methods
- Tests with mock event streams

New zulip-ts API additions:
- Update `registerQueue` to accept `fetch_event_types` and return `unread_msgs` in initial state
- Parse the `unread_msgs` structure (streams, DMs, mentions)
- Tagged ID types already in place (PR #61): `MessageId`, `StreamId`, `UserId`, `TopicName`, `ChannelName`, etc.

Session startup sequence:
1. `registerQueue` with `all_public_streams: true` to get `unread_msgs`
2. `getMembers` API call to populate the members cache (not available from `registerQueue` initial state)
3. Start long-poll loop

### Step 2: Topic visibility, members, and notification logic

Add to `ZulipSession`:
- Track `user_topic` events for follow/mute state
- Track `realm_user` events to keep members cache current (new users, name changes, deactivations)
- `shouldNotify(message)` evaluating: DM, mentions (from flags), followed topic
- `getTopicVisibility`, `isFollowed`, `resolveUserId`, `resolveName` query methods
- Tests for notification trigger logic

### Step 3: Integrate with zulr event listener

Replace the current "deliver everything to inbox" with:
- `EventListenerManager` creates `ZulipSession` per bot (replaces `runBotListener`)
- Session calls zulr-provided callback on notification-worthy messages
- Non-notification messages update session state silently
- Bots explicitly follow topics via `setTopicVisibility(FOLLOWED)` when posting or being @-mentioned

### Step 4: `reply` and `topic-state` tools

- `reply` tool: checks `session.hasUnreads()` before posting, covers all unreads in topic
- `topic-state` tool: queries session for unread count, visibility, last activity
- Update `post` tool description to clarify it skips unread checks

### Step 5: Local read optimization (optional)

- Cache recent messages from events in the session
- `read` tool can serve from cache when data is fresh
- Reduces API calls for frequently-read topics

## Design Decisions

**Per-bot sessions, no shared state**: Each bot maintains independent state. Simpler than shared caching with permission checks. Can optimize later.

**Notification triggers match Zulip's model**: DMs, @-mentions, followed topics. Replicates the same logic the Zulip web client uses for desktop notifications. No custom notification preferences for now — can add later if needed.

**`reply` vs `post` instead of `force` param**: Separate tools with clear semantics are more discoverable than a boolean flag. Agents naturally reach for `reply` in conversation and `post` for announcements.

**`reply` checks all unreads, not just recent**: Simpler and more transparent. The error message tells agents the count and age, and `post` provides the escape hatch. Avoids the complexity of tracking "last activity per topic" with fuzzy semantics.

**Unread state is Zulip-native**: Tracked via Zulip's own unread_msgs + event updates. No custom SQLite tables or inbox-based approximations.

**Tagged types (already landed)**: PR #61 introduced branded types for all numeric IDs (`UserId`, `MessageId`, `StreamId`, `EventId`, `UnixEpochSeconds`) and string values (`ChannelName`, `TopicName`, `Email`, `DisplayName`, etc.) across both `zulip-ts` and `zulr`. The `ZulipSession` interface uses these throughout.

**Full state reset on reconnection**: When the event queue expires, the session re-registers and replaces all local state from the fresh initial snapshot. Simple and correct — avoids incremental patching of potentially stale state.
