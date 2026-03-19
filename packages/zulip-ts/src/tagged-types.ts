import type { Tagged } from 'type-fest'

/** Zulip user ID (distinct from message, stream, and event IDs). */
export type UserId = Tagged<number, 'UserId'>

/** Zulip message ID (distinct from user, stream, and event IDs). */
export type MessageId = Tagged<number, 'MessageId'>

/** Zulip stream/channel ID (distinct from user, message, and event IDs). */
export type StreamId = Tagged<number, 'StreamId'>

/** Zulip event ID (distinct from user, message, and stream IDs). */
export type EventId = Tagged<number, 'EventId'>

/** Unix timestamp in seconds since epoch (1970-01-01T00:00:00Z). */
export type UnixEpochSeconds = Tagged<number, 'UnixEpochSeconds'>

/** Zulip channel (stream) name. */
export type ChannelName = Tagged<string, 'ChannelName'>

/** Zulip topic name within a channel. */
export type TopicName = Tagged<string, 'TopicName'>

/** Email address (login or API email). */
export type Email = Tagged<string, 'Email'>

/** Human-readable display name (full_name / sender_full_name). */
export type DisplayName = Tagged<string, 'DisplayName'>

/** Zulip emoji name (e.g. "thumbs_up", "heart"). */
export type EmojiName = Tagged<string, 'EmojiName'>

/** Zulip event queue ID returned by /register. */
export type QueueId = Tagged<string, 'QueueId'>

/** Zulip API key for authentication. */
export type ApiKey = Tagged<string, 'ApiKey'>
