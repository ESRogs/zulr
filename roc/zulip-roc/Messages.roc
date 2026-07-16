## Request builder and response decoder for GET /api/v1/messages/{message_id}.
##
## Fetching one message at a time keeps decoding simple: the response is a
## single JSON object that can be decoded twice — once for the fields shared
## by every message type, then again for the stream-only fields — instead of
## decoding a heterogeneous list.

import http.Request
import Api
import FormUrlEncoded

Messages := [].{

	## A message as needed for wake-up decisions. `flags` are the requesting
	## user's flags on the message (mentions show up here).
	Message : [
		Stream({ id : I64, sender_id : I64, flags : List(Str), stream_id : I64, topic : Str }),
		Private({ id : I64, sender_id : I64, flags : List(Str) }),
	]

	## Build GET /api/v1/messages/{message_id}.
	get_request : Str, I64 -> Request.Request
	get_request = |base, message_id|
		Request.from_method(GET).with_uri("${base}/api/v1/messages/${I64.to_str(message_id)}")

	## Build POST /api/v1/messages/flags — mark messages read (or otherwise
	## flagged) for the requesting user.
	flags_request : Str, { message_ids : List(I64), op : Str, flag : Str } -> Request.Request
	flags_request = |base, opts| {
		ids_json = "[${Str.join_with(opts.message_ids.map(I64.to_str), ",")}]"
		pairs = [
			("messages", ids_json),
			("op", opts.op),
			("flag", opts.flag),
		]
		Request.from_method(POST)
			.with_uri("${base}/api/v1/messages/flags")
			.add_header("Content-Type", "application/x-www-form-urlencoded")
			.with_body(Str.to_utf8(FormUrlEncoded.encode_pairs(pairs)))
	}

	## A message with sender and content — what a reaction notification needs
	## to decide authorship and render a preview. Single-object responses CAN
	## branch-decode display_recipient (unlike event batches), so the stream
	## variant carries its stream name.
	FullMessage : [
		StreamMessage({ id : I64, sender_id : I64, sender_email : Str, content : Str, stream : Str, topic : Str }),
		DmMessage({ id : I64, sender_id : I64, sender_email : Str, content : Str }),
	]

	## Decode a single-message response with content, branching on type.
	decode_full_message : Str -> Try(FullMessage, [ApiError(Api.ErrorBody), BadResponse(Str), ..])
	decode_full_message = |raw| {
		core : Try({ message : { id : I64, sender_id : I64, sender_email : Str, type : Str, content : Str } }, _)
		core = Json.parse(raw)
		match core {
			Ok({ message }) => {
				if message.type == "stream" {
					stream_part : Try({ message : { display_recipient : Str, subject : Str } }, _)
					stream_part = Json.parse(raw)
					match stream_part {
						Ok(s) =>
							Ok(
								StreamMessage({
									id: message.id,
									sender_id: message.sender_id,
									sender_email: message.sender_email,
									content: message.content,
									stream: s.message.display_recipient,
									topic: s.message.subject,
								}),
							)
						Err(_) => Err(BadResponse(raw))
					}
				} else {
					Ok(DmMessage({ id: message.id, sender_id: message.sender_id, sender_email: message.sender_email, content: message.content }))
				}
			}
			Err(_) => Err(Api.decode_failure(raw))
		}
	}

	## Decode a single-message response, branching on the message's type.
	decode_message : Str -> Try(Message, [ApiError(Api.ErrorBody), BadResponse(Str), ..])
	decode_message = |raw| {
		core : Try({ message : { id : I64, sender_id : I64, type : Str, flags : List(Str) } }, _)
		core = Json.parse(raw)
		match core {
			Ok({ message }) => {
				if message.type == "stream" {
					stream_part : Try({ message : { stream_id : I64, subject : Str } }, _)
					stream_part = Json.parse(raw)
					match stream_part {
						Ok(s) =>
							Ok(
								Stream({
									id: message.id,
									sender_id: message.sender_id,
									flags: message.flags,
									stream_id: s.message.stream_id,
									topic: s.message.subject,
								}),
							)
						Err(_) => Err(BadResponse(raw))
					}
				} else {
					Ok(Private({ id: message.id, sender_id: message.sender_id, flags: message.flags }))
				}
			}
			Err(_) => Err(Api.decode_failure(raw))
		}
	}
}

# --- tests ---

expect
	Messages.get_request("https://x.zulipchat.com", 42).uri()
		== "https://x.zulipchat.com/api/v1/messages/42"

expect
	Messages.decode_message("{\"result\":\"success\",\"message\":{\"id\":9,\"sender_id\":101,\"type\":\"stream\",\"flags\":[\"mentioned\"],\"stream_id\":7,\"subject\":\"pr-42\",\"content\":\"hi\"}}")
		== Ok(Stream({ id: 9, sender_id: 101, flags: ["mentioned"], stream_id: 7, topic: "pr-42" }))

expect
	Messages.decode_message("{\"result\":\"success\",\"message\":{\"id\":10,\"sender_id\":102,\"type\":\"private\",\"flags\":[],\"content\":\"psst\"}}")
		== Ok(Private({ id: 10, sender_id: 102, flags: [] }))

expect
	Messages.decode_message("{\"result\":\"error\",\"msg\":\"Invalid message(s)\",\"code\":\"BAD_REQUEST\"}")
		== Err(ApiError({ code: "BAD_REQUEST", msg: "Invalid message(s)" }))

# escape sequences in decoded strings (quotes, \uXXXX, surrogate pairs) and
# in skipped fields survive with full fidelity
expect
	Messages.decode_message("{\"result\":\"success\",\"message\":{\"id\":9,\"sender_id\":101,\"type\":\"stream\",\"flags\":[],\"stream_id\":7,\"subject\":\"roc says \\\"kree\\\" caf\\u00e9 \\ud83e\\udd85\",\"content\":\"skipped \\\"escapes\\\" here\\ntoo\"}}")
		== Ok(Stream({ id: 9, sender_id: 101, flags: [], stream_id: 7, topic: "roc says \"kree\" café 🦅" }))

expect
	Messages.flags_request("https://x.zulipchat.com", { message_ids: [77, 78], op: "add", flag: "read" }).body()
		== Str.to_utf8("messages=%5B77%2C78%5D&op=add&flag=read")

expect
	Messages.decode_full_message("{\"result\":\"success\",\"message\":{\"id\":9,\"sender_id\":101,\"sender_email\":\"ada@x.com\",\"type\":\"stream\",\"content\":\"nice work\",\"display_recipient\":\"general\",\"subject\":\"pr-42\",\"flags\":[]}}")
		== Ok(StreamMessage({ id: 9, sender_id: 101, sender_email: "ada@x.com", content: "nice work", stream: "general", topic: "pr-42" }))

expect
	Messages.decode_full_message("{\"result\":\"success\",\"message\":{\"id\":10,\"sender_id\":102,\"sender_email\":\"bo@x.com\",\"type\":\"private\",\"content\":\"psst\",\"display_recipient\":[{\"email\":\"bot@x.com\"},{\"email\":\"bo@x.com\"}]}}")
		== Ok(DmMessage({ id: 10, sender_id: 102, sender_email: "bo@x.com", content: "psst" }))

# stream message missing its stream fields is a BadResponse, not a crash
expect
	match Messages.decode_full_message("{\"result\":\"success\",\"message\":{\"id\":11,\"sender_id\":103,\"sender_email\":\"c@x.com\",\"type\":\"stream\",\"content\":\"hi\"}}") {
		Err(BadResponse(_)) => Bool.True
		_ => Bool.False
	}
