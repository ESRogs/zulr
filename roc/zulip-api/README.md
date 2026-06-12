# zulip-api (Roc)

A pure request-builder layer for the [Zulip REST API](https://zulip.com/api/),
written in Roc for the new (zig-based) compiler. Ported from this repo's
TypeScript implementation (`packages/zulip-ts`) as an experiment in the
**pure-descriptor pattern** for HTTP API clients — the approach discussed in
the Roc Zulip `#ideas` thread on standardizing HTTP: the library *describes*
requests and prepares everything needed to send them; the actual HTTP send
belongs to the host/platform (cf. Gleam's `gleam/http` + `gleam_httpc` split).

## Shape

```roc
channel : ChannelName
channel = "general"

topic : TopicName
topic = "greetings"

req = Messages.send_stream_message(channel, topic, "Hello from Roc!")

req.method_str()                          # "POST"
req.url("https://chat.example.com")      # "https://chat.example.com/api/v1/messages"
req.form_body()                          # "type=stream&to=general&subject=greetings&content=Hello+from+Roc%21"
req.headers(email, api_key)              # [("Authorization", "Basic ..."), ("Content-Type", "application/x-www-form-urlencoded")]
```

Everything above is a pure function — no effects anywhere in the package.
A host (CLI platform, web server, test harness) takes the descriptor and
performs the send however it likes.

## Modules

| Module | What it is |
|---|---|
| `Request.roc` | The request descriptor (method/path/params/body) + URL, auth-header, and form-body preparation |
| `Messages.roc` | Builders for the `/messages` endpoints (send DM/stream message, get messages with narrows, flags, reactions) |
| `UserId.roc`, `MessageId.roc`, `StreamId.roc`, `ChannelName.roc`, `TopicName.roc`, `EmojiName.roc`, `Email.roc`, `ApiKey.roc` | Branded ID types, one module per type (the module-name-equals-type-name idiom) — the Roc equivalent of `type-fest`'s `Tagged`. `UserId.roc` documents the pattern |
| `FormUrlEncoded.roc` | `application/x-www-form-urlencoded` serializer matching WHATWG/`URLSearchParams` semantics |
| `Base64.roc` | RFC 4648 base64 (for the Basic auth header) |

## Design notes

- **The payload is a tag union, not two fields**:
  `payload : [Query(...), Form(...)]`. A request carries query params *or* a
  form body, never both — the original TS `RequestOptions` allowed passing
  `params` on a POST, which silently became the form body (client.ts:91).
  That state is unrepresentable here.
- **Pairs are `List((Str, Str))`, not `Dict`** — order is preserved and
  duplicate keys are representable, so no information is discarded before the
  wire (one of the design criteria raised in the standardize-HTTP thread).
- **Branded IDs are kept everywhere** (`ChannelName`, not bare `Str`),
  and they're **opaque** (`::`): construction is sealed to `from()` and
  literals, reading to the `to_*` methods — unlike TS `Tagged`, no cast or
  structural value bypasses the brand. Yet use sites are *terser* than TS
  `as`: via the `from_numeral`/`from_quote` dispatch hooks, plain literals
  construct brands wherever the expected type is known (annotations, function
  arguments, record fields), checked at compile time —
  ```roc
  sender : UserId
  sender = 101

  channel : ChannelName
  channel = "general"
  ```
- **Multi-parameter endpoints take records** (`get_messages({ anchor, num_before, ... })`)
  so same-typed counts can't be transposed — matching the safety the TS
  params objects provided.
- **Wire-format parity with the TS implementation is tested**: serialization
  matches JS `String()` / `JSON.stringify` / `URLSearchParams` behavior, with
  expected values cross-checked against independent implementations (python
  `base64`/`urlencode`/`json` — including the known `*`/`~` divergences between
  python and WHATWG, where this package follows WHATWG).
- **Branded IDs are record-backed** (`{ val : U64 }`) rather than scalar-backed
  — see compiler bug 2 below.

## Run the tests

```sh
roc check main.roc
roc test main.roc    # 51 expects
```

## Things that had to be hand-rolled (stdlib/package candidates?)

- base64 encoding
- percent-/form-url-encoding (WHATWG serializer rules)
- JSON string escaping (for `narrow=` values)

## Compiler notes from this port

On nightly `305f7f3` (2026-06-03) we hit several SIGSEGVs around scalar-backed
nominal types (`UserId := U64` with methods — nested or not, any construction
syntax) and one on package-level `roc check` with parse errors in a member
module. **All of these are fixed as of `5a8047b8` (2026-06-12)** — they now
produce ordinary type errors, so we never filed them.

What remains true on `5a8047b8`:

1. **Scalar-backed nominals have no construction path.** Structural→nominal
   unification ("auto-wrap") exists for tag-union and record backings (see
   roc PR #8835) but not bare scalars: `from : U64 -> UserId; from = |n| n`
   is a type mismatch. Single-tag-union backing (`UserId :: [Id(U64)]`) is
   the supported idiom — it's also what the compiler's own custom-numeral
   snapshot tests use, so that's what the brand modules do.
2. **Custom literal support is real and recent**: `from_numeral` (roc #9619,
   landed 2026-06-11) and `from_quote` (roc #9620) let number and string
   literals construct nominal types, evaluated/checked at compile time. This
   is how the brand modules get literal construction.
3. The langref's "Constructing Nominal Types" section is still an empty
   heading — the above was reverse-engineered from snapshot tests and PRs.
4. **New SIGSEGV (still live on `5a8047b8`, not yet reported)**: the
   number-literal suffix form crashes when the type is a *nested* nominal —
   `7.Ids.UserId` (where `UserId` is nested inside an `Ids` namespace type)
   segfaults `roc check`. Single-segment suffixes like the `123.Foo` in the
   compiler's own snapshot are fine; this package no longer uses nested
   types, but the repro is preserved for reporting.

(Also noted, possibly by design: `match` can't appear inside string
interpolation, and `crash` in a match arm requires a braced block.)

## Not yet ported

Response types and JSON decoding (the zod half of `zulip-ts`), the remaining
endpoint groups (streams, events, users, bots, files), and a host integration
to actually send requests once a platform with an HTTP effect is available
for the new compiler.
