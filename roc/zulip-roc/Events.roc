## Request builders and response decoders for the Zulip event-queue endpoints:
## POST /api/v1/register, GET /api/v1/events, DELETE /api/v1/events.
##
## Builders are pure functions producing `http.Request` values; decoders are
## pure functions over response body strings. Sending belongs to the caller
## (see Client and Session).
##
## Poll responses decode only each event's `{id, type}` — the shape shared by
## every event type. Full message payloads are fetched per-id via
## Messages.get_request, which lets a single JSON object be branch-decoded by
## message type instead of decoding a heterogeneous event list.

import http.Request
import Api
import FormUrlEncoded

Events := [].{

	EventMeta : { id : I64, type : Str }

	UserTopic : { stream_id : I64, topic_name : Str, visibility_policy : I64 }

	RegisterOptions : {
		event_types : List(Str),
		fetch_event_types : List(Str),
		all_public_streams : Bool,
	}

	Registered : { queue_id : Str, last_event_id : I64, user_topics : List(UserTopic) }

	## Build POST /api/v1/register. `base` is the site URL without a trailing
	## slash, e.g. "https://example.zulipchat.com".
	register_request : Str, RegisterOptions -> Request.Request
	register_request = |base, opts| {
		pairs = [
			("event_types", json_str_list(opts.event_types)),
			("fetch_event_types", json_str_list(opts.fetch_event_types)),
			("all_public_streams", bool_str(opts.all_public_streams)),
		]
		Request.from_method(POST)
			.with_uri("${base}/api/v1/register")
			.add_header("Content-Type", "application/x-www-form-urlencoded")
			.with_body(Str.to_utf8(FormUrlEncoded.encode_pairs(pairs)))
	}

	## Decode a register response. `user_topics` is present only when
	## user_topic is in fetch_event_types; it defaults to [] when absent.
	decode_registered : Str -> Try(Registered, [ApiError(Api.ErrorBody), BadResponse(Str), ..])
	decode_registered = |raw| {
		core : Try({ queue_id : Str, last_event_id : I64 }, _)
		core = Json.parse(raw)
		match core {
			Ok({ queue_id, last_event_id }) => {
				user_topics = decode_user_topics(raw)?
				Ok({ queue_id, last_event_id, user_topics })
			}
			Err(_) => Err(Api.decode_failure(raw))
		}
	}

	## `user_topics` decodes as [] when absent — but present-and-malformed is
	## an error: silently falling back to [] there would disable followed-topic
	## behavior on any payload shape drift, while everything else keeps working.
	## The probe decode (elements as `{}`) tells the two cases apart.
	decode_user_topics : Str -> Try(List(UserTopic), [BadResponse(Str), ..])
	decode_user_topics = |raw| {
		typed : Try({ user_topics : List(UserTopic) }, _)
		typed = Json.parse(raw)
		match typed {
			Ok(t) => Ok(t.user_topics)
			Err(_) => {
				probe : Try({ user_topics : List({}) }, _)
				probe = Json.parse(raw)
				match probe {
					Ok(_) => Err(BadResponse(raw))
					Err(_) => Ok([])
				}
			}
		}
	}

	## Build GET /api/v1/events with dont_block=true — the non-blocking poll.
	poll_request : Str, Str, I64 -> Request.Request
	poll_request = |base, queue_id, last_event_id| {
		query = FormUrlEncoded.encode_pairs([
			("queue_id", queue_id),
			("last_event_id", I64.to_str(last_event_id)),
			("dont_block", "true"),
		])
		Request.from_method(GET).with_uri("${base}/api/v1/events?${query}")
	}

	## A decoded poll batch. `events` always carries every event's id (for
	## cursor advancement). `message_ids` are the Zulip message ids of the
	## batch's message events — extracted with a second wholesale decode,
	## which requires the batch to be all message events. On a message-only
	## queue that's every non-empty batch in practice; if some other event
	## type sneaks in (heartbeat, server restart), the ids can't be extracted
	## and `lossy` is set so the caller can log the dropped batch.
	Polled : { events : List(EventMeta), message_ids : List(I64), lossy : Bool }

	## Decode a poll response.
	decode_poll : Str -> Try(Polled, [ApiError(Api.ErrorBody), BadResponse(Str), ..])
	decode_poll = |raw| {
		parsed : Try({ events : List(EventMeta) }, _)
		parsed = Json.parse(raw)
		match parsed {
			Ok({ events }) => {
				has_messages = events.any(|ev| ev.type == "message")
				if !has_messages {
					Ok({ events, message_ids: [], lossy: Bool.False })
				} else {
					with_ids : Try({ events : List({ message : { id : I64 } }) }, _)
					with_ids = Json.parse(raw)
					match with_ids {
						Ok(full) => Ok({ events, message_ids: full.events.map(|ev| ev.message.id), lossy: Bool.False })
						Err(_) => Ok({ events, message_ids: [], lossy: Bool.True })
					}
				}
			}
			Err(_) => Err(Api.decode_failure(raw))
		}
	}

	## Build DELETE /api/v1/events — clean up a queue.
	delete_request : Str, Str -> Request.Request
	delete_request = |base, queue_id| {
		query = FormUrlEncoded.encode_pairs([("queue_id", queue_id)])
		Request.from_method(DELETE).with_uri("${base}/api/v1/events?${query}")
	}

	## Encode a list of strings as a JSON array (for event_types= form values).
	json_str_list : List(Str) -> Str
	json_str_list = |strs|
		match Json.to_str_try(strs) {
			Ok(s) => s
			Err(_) => {
				crash "unreachable: encoding List(Str) to JSON cannot fail"
			}
		}

	bool_str : Bool -> Str
	bool_str = |b| if b "true" else "false"
}

# --- builder tests ---

expect Events.json_str_list(["message", "user_topic"]) == "[\"message\",\"user_topic\"]"
expect Events.json_str_list([]) == "[]"

expect
	Events.register_request("https://x.zulipchat.com", { event_types: ["message"], fetch_event_types: ["user_topic"], all_public_streams: Bool.True })
		.body()
		== Str.to_utf8("event_types=%5B%22message%22%5D&fetch_event_types=%5B%22user_topic%22%5D&all_public_streams=true")

# --- decoder tests ---

expect
	Events.decode_registered("{\"result\":\"success\",\"queue_id\":\"q:1\",\"last_event_id\":-1,\"user_topics\":[{\"stream_id\":7,\"topic_name\":\"pr-42\",\"visibility_policy\":3,\"last_updated\":123}],\"extra\":true}")
		== Ok({ queue_id: "q:1", last_event_id: -1, user_topics: [{ stream_id: 7, topic_name: "pr-42", visibility_policy: 3 }] })

expect
	Events.decode_registered("{\"result\":\"success\",\"queue_id\":\"q:2\",\"last_event_id\":5}")
		== Ok({ queue_id: "q:2", last_event_id: 5, user_topics: [] })

expect
	Events.decode_registered("{\"result\":\"error\",\"msg\":\"nope\",\"code\":\"BAD_REQUEST\"}")
		== Err(ApiError({ code: "BAD_REQUEST", msg: "nope" }))

# user_topics present but with an unexpected element shape is an error,
# not a silent empty list
expect
	Events.decode_registered("{\"result\":\"success\",\"queue_id\":\"q:3\",\"last_event_id\":0,\"user_topics\":[{\"stream\":7}]}")
		== Err(BadResponse("{\"result\":\"success\",\"queue_id\":\"q:3\",\"last_event_id\":0,\"user_topics\":[{\"stream\":7}]}"))

# all-message batch: message ids extracted
expect
	Events.decode_poll("{\"result\":\"success\",\"events\":[{\"id\":0,\"type\":\"message\",\"flags\":[],\"message\":{\"id\":608849534,\"type\":\"private\"}},{\"id\":1,\"type\":\"message\",\"message\":{\"id\":608849535}}]}")
		== Ok({ events: [{ id: 0, type: "message" }, { id: 1, type: "message" }], message_ids: [608849534, 608849535], lossy: Bool.False })

# mixed batch: ids can't be extracted wholesale — flagged lossy
expect
	Events.decode_poll("{\"result\":\"success\",\"events\":[{\"id\":0,\"type\":\"message\",\"message\":{\"id\":42}},{\"id\":1,\"type\":\"heartbeat\"}]}")
		== Ok({ events: [{ id: 0, type: "message" }, { id: 1, type: "heartbeat" }], message_ids: [], lossy: Bool.True })

# message content containing quotes/escapes must not break the batch decode
expect
	Events.decode_poll("{\"result\":\"success\",\"events\":[{\"id\":2,\"type\":\"message\",\"message\":{\"id\":77,\"content\":\"she said \\\"hi\\\"\\nback\"}}]}")
		== Ok({ events: [{ id: 2, type: "message" }], message_ids: [77], lossy: Bool.False })

# non-message events need no second decode
expect
	Events.decode_poll("{\"result\":\"success\",\"events\":[{\"id\":3,\"type\":\"heartbeat\"}]}")
		== Ok({ events: [{ id: 3, type: "heartbeat" }], message_ids: [], lossy: Bool.False })

expect
	Events.decode_poll("{\"result\":\"success\",\"events\":[]}")
		== Ok({ events: [], message_ids: [], lossy: Bool.False })

expect
	Events.decode_poll("{\"result\":\"error\",\"msg\":\"Bad event queue ID: q:1\",\"code\":\"BAD_EVENT_QUEUE_ID\"}")
		== Err(ApiError({ code: "BAD_EVENT_QUEUE_ID", msg: "Bad event queue ID: q:1" }))
