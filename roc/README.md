# zulr → Roc

A gradual migration of zulr to [Roc](https://www.roc-lang.org/) (the new
Zig-based compiler): a platform-agnostic Zulip client package plus rewrites
of zulr's standalone processes as apps consuming it. The TypeScript versions
(`packages/zulr/src/dispatcher.ts`, `packages/zulr/src/zulip/event-listener.ts`)
remain the fallback; nothing in the TS packages changed.

## Layout

- `zulip-roc/` — Zulip API client package. Sans-io core (pure request
  builders + response decoders, fully covered by `roc test`) plus a thin
  effectful layer (`Client`, `Session`) with an injected transport.
- `dispatcher/` — the dispatcher app: watches Zulip for DMs, @-mentions, and
  followed-topic messages aimed at stopped mngr agents and wakes them via
  `mngr start`.
- `event-listener/` — the event listener app: delivers DMs, notification-worthy
  stream messages, and reactions to Claude Code teammate inbox files, marks
  delivered messages read, auto-follows topics on mention, and auto-unfollows
  resolved topics after a grace period. Inbox *consumption* stays in the TS
  MCP server; this app only appends.

## Toolchain (pinned)

| Component | Version |
|---|---|
| roc | nightly 2026-07-14 (`c9147c2`) from roc-lang/nightlies |
| basic-cli | 0.21.0-rc4 (URL platform dep — no local clone or host build needed) |
| roc-lang/http | 1.0.0 (URL package dep) |

Both halves of the pin move fast and independently; upgrading either is a
deliberate step, not automatic.

## Build / test / run

```sh
cd roc/zulip-roc && roc test main.roc        # package: pure tests
cd roc/dispatcher && roc test main.roc       # app: pure-helper tests
cd roc/dispatcher && roc build main.roc      # produces ./main
cd roc/event-listener && roc test main.roc   # app + Inbox module tests
cd roc/event-listener && roc build main.roc

ZULIP_SITE=https://your-org.zulipchat.com \
ZULR_STATE_DB=~/.zulr/<slug>/state.db \
./main
```

Env: `ZULIP_SITE` is required. The state DB is found via `ZULR_STATE_DB`, or
derived as `$HOME/.zulr/<slug>/state.db` from `ZULR_REPO_ROOT` (slug = the
absolute repo path with `/` → `-`, matching `state/db.ts`). The event
listener additionally reads `ZULR_TEAM` (inbox team name, default "default")
and writes inbox files under `$HOME/.claude/teams/<team>/inboxes/`.

## Design

**zulip-roc is platform-agnostic**: it declares no hosted effects. The app
injects the transport at construction:

```roc
client = Client.new({ site, email, api_key }, |req| Http.send!(req).map_err(Str.inspect))
```

Request/Response nominal types come from the shared roc-lang/http package (its
stated purpose), so any platform exposing an `Http.send!` can drive the
client. Transport errors are erased to `Str` at the injection boundary to keep
the client type platform-independent.

**Single-loop concurrency.** The basic-cli platform exposes no spawn/threads/
futures (confirmed against the full `hosted_*` surface), so the dispatcher is
one loop that short-polls every bot's event queue (`dont_block=true`) each
sweep, then sleeps (`sweep = 3s`). `Session.poll!` is the non-blocking
primitive; the app owns the outer loop. Server-side queues buffer between
sweeps. Long-poll would only be an optimization and is not load-bearing.

**Event decoding.** Roc's builtin JSON decoder tolerates extra fields but not
missing ones, and there is no dynamic JSON value type — so heterogeneous
event lists can't be decoded into one record shape. The dispatcher's queues
register `event_types=["message"]`, poll decoding extracts `{id, type}` per
event (shared by all event types) plus message ids via a second wholesale
decode (all-message batches only — guaranteed on a message-only queue except
for rare server-generated events, which are logged and skipped), and full
messages are fetched per-id via `GET /messages/{id}`, whose single-object
response can be branch-decoded by message type. Followed-topic state comes
from the register response (`fetch_event_types=["user_topic"]`) and is
refreshed by re-registering every 5 minutes.

**Wake logic** (ported from `dispatcher.ts` + `zulip-client-ts`
`notifications.ts`): DM → wake; `mentioned`/`wildcard_mentioned` flag → wake;
topic followed (visibility policy 3) → wake; else silent. Only known-stopped
agents are woken (`mngr list --format json`, refreshed every 30s), with a 60s
per-agent cooldown.

**Listener event decoding.** Unlike the dispatcher, the listener needs event
*payloads*, and its queues carry mixed event types. One decode shape covers
the whole batch: every per-type field is optional (`Try(a, [Missing])` —
absent decodes as `Missing`), and `Events.classify_event` sorts elements into
message / reaction / topic-rename / other afterward. The one field this can't
express is a message's `display_recipient`, whose JSON *type* differs between
stream messages (stream name string) and DMs (recipient list) — a present
field of the wrong type fails the whole decode rather than reading as
Missing. Stream names therefore resolve from a channel cache
(`GET /streams`, refreshed on miss), and DMs need no recipient data at all
(a per-bot queue only delivers DMs the bot participates in).

**Listener delivery.** Inbox files are shared with Claude Code's own team
runtime, so existing content is never re-encoded: new entries are spliced
into the JSON array textually (`Inbox.append_to_array`), preserving entries
and fields this code doesn't model. Delivery dedupes on `zulipMessageId`,
and messages are marked read on Zulip only after a successful inbox write
(the TS listener marks read regardless; keeping the message unread on write
failure means catch-up can still find it). Resolved-topic auto-unfollow is
scheduled as due-times checked each sweep — the single loop has no timers.

**Known listener gap:** no backfill after queue expiry — events between the
queue dying and re-registration are lost (logged). The TS listener backfills
unreads on reconnect; porting that needs the narrow/anchor message-search
endpoints.

## Roc gotchas encountered (nightly c9147c2)

- `crash` in a match arm must be wrapped in a braced block.
- `?` unwraps, so a function returning `Try` still ends with explicit `Ok(...)`.
- Error tag unions in signatures need `..` (open) to widen across `?`
  propagation between functions.
- `expect` must be pure — annotated-`=>` functions can't be tested with pure
  stubs; factor logic into pure helpers instead.
- Top-level constants can't be ALL_CAPS (uppercase names are types/tags).
- Record patterns in `match` are closed: use `{ field, .. }` to ignore rest.
- Zero-arg effectful functions: annotation `() =>`, lambda `||`.
- Number type suffixes are `1.I64`, not `1i64`.
