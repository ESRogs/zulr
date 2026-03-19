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
