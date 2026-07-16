# zulr → Roc

The first slice of a gradual migration of zulr to [Roc](https://www.roc-lang.org/)
(the new Zig-based compiler): a platform-agnostic Zulip client package and a
rewrite of the dispatcher as an app consuming it. The TypeScript dispatcher
(`packages/zulr/src/dispatcher.ts`) remains the fallback; nothing in the TS
packages changed.

## Layout

- `zulip-roc/` — Zulip API client package. Sans-io core (pure request
  builders + response decoders, fully covered by `roc test`) plus a thin
  effectful layer (`Client`, `Session`) with an injected transport.
- `dispatcher/` — the dispatcher app: watches Zulip for DMs, @-mentions, and
  followed-topic messages aimed at stopped mngr agents and wakes them via
  `mngr start`.

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
cd roc/zulip-roc && roc test main.roc     # package: pure tests
cd roc/dispatcher && roc test main.roc    # app: pure-helper tests
cd roc/dispatcher && roc build main.roc   # produces ./main

ZULIP_SITE=https://your-org.zulipchat.com \
ZULR_STATE_DB=~/.zulr/<slug>/state.db \
./main
```

Env: `ZULIP_SITE` is required. The state DB is found via `ZULR_STATE_DB`, or
derived as `$HOME/.zulr/<slug>/state.db` from `ZULR_REPO_ROOT` (slug = the
absolute repo path with `/` → `-`, matching `state/db.ts`).

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
