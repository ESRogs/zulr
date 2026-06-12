## Pure request builders for the Zulip /messages endpoints,
## ported from zulip-ts/src/messages.ts.
##
## Each function returns a Request descriptor; the host performs the send.
## Serialization mirrors the TS code exactly: JS `String()` for numbers and
## booleans, `JSON.stringify` for arrays/objects (lists of IDs, narrow
## filters), raw strings passed through.

import ChannelName
import EmojiName
import MessageId
import TopicName
import UserId
import Request

Messages := [].{

	## A narrow filter, e.g. { operator: "sender", operand: ... }.
	## Operand mirrors the TS union `string | number | readonly number[]`.
	Narrow := {
		operator : Str,
		operand : [Text(Str), Number(U64), Numbers(List(U64))],
	}.{
		by_str : Str, Str -> Messages.Narrow
		by_str = |operator, operand| { operator: operator, operand: Text(operand) }

		by_num : Str, U64 -> Messages.Narrow
		by_num = |operator, operand| { operator: operator, operand: Number(operand) }
	}

	## POST /messages with type=direct. `to` is a JSON array of user IDs.
	send_direct_message : List(UserId), Str -> Request
	send_direct_message = |to, content|
		Request.post(
			"/messages",
			[
				("type", "direct"),
				("to", json_u64_list(to.map(|id| id.to_u64()))),
				("content", content),
			],
		)

	## POST /messages with type=stream.
	send_stream_message : ChannelName, TopicName, Str -> Request
	send_stream_message = |to, topic, content|
		Request.post(
			"/messages",
			[
				("type", "stream"),
				("to", to.to_str()),
				("subject", topic.to_str()),
				("content", content),
			],
		)

	## POST /messages/flags — add or remove a flag on a set of messages.
	update_message_flags : List(MessageId), [Add, Remove], Str -> Request
	update_message_flags = |message_ids, op, flag|
		Request.post(
			"/messages/flags",
			[
				("messages", json_u64_list(message_ids.map(|id| id.to_u64()))),
				("op", match op {
					Add => "add"
					Remove => "remove"
				}),
				("flag", flag),
			],
		)

	## Mark specific messages as read.
	mark_as_read : List(MessageId) -> Request
	mark_as_read = |message_ids|
		update_message_flags(message_ids, Add, "read")

	## POST /messages/{id}/reactions
	add_reaction : MessageId, EmojiName -> Request
	add_reaction = |message_id, emoji_name|
		Request.post(
			"/messages/${message_id.serialize()}/reactions",
			[("emoji_name", emoji_name.to_str())],
		)

	## DELETE /messages/{id}/reactions
	remove_reaction : MessageId, EmojiName -> Request
	remove_reaction = |message_id, emoji_name|
		Request.delete(
			"/messages/${message_id.serialize()}/reactions",
			[("emoji_name", emoji_name.to_str())],
		)

	## GET /messages/{id}
	get_message : MessageId, Bool -> Request
	get_message = |message_id, apply_markdown|
		Request.get(
			"/messages/${message_id.serialize()}",
			[("apply_markdown", bool_str(apply_markdown))],
		)

	## GET /messages with anchor/narrow pagination. Takes a record so the two
	## U64 counts can't be transposed silently (mirrors the TS params object).
	get_messages : {
		anchor : [Newest, Oldest, FirstUnread, At(MessageId)],
		num_before : U64,
		num_after : U64,
		narrow : List(Messages.Narrow),
		apply_markdown : Bool,
	}
		-> Request
	get_messages = |opts|
		Request.get(
			"/messages",
			[
				("anchor", match opts.anchor {
					Newest => "newest"
					Oldest => "oldest"
					FirstUnread => "first_unread"
					At(id) => id.serialize()
				}),
				("num_before", opts.num_before.to_str()),
				("num_after", opts.num_after.to_str()),
				("narrow", json_narrow(opts.narrow)),
				("apply_markdown", bool_str(opts.apply_markdown)),
			],
		)

	# --- serialization helpers (match JS String()/JSON.stringify) ---

	bool_str : Bool -> Str
	bool_str = |b| if b "true" else "false"

	## JSON.stringify for a list of integers: [101,102]
	json_u64_list : List(U64) -> Str
	json_u64_list = |ns|
		"[${Str.join_with(ns.map(|n| n.to_str()), ",")}]"

	## JSON.stringify for narrow filters:
	## [{"operator":"sender","operand":"a@b.c"},...]
	json_narrow : List(Messages.Narrow) -> Str
	json_narrow = |filters| {
		objs = filters.map(|f| {
			operand_json = match f.operand {
				Text(s) => json_str(s)
				Number(n) => n.to_str()
				Numbers(ns) => json_u64_list(ns)
			}
			"{\"operator\":${json_str(f.operator)},\"operand\":${operand_json}}"
		})
		"[${Str.join_with(objs, ",")}]"
	}

	## Minimal JSON string encoding: escapes `"`, `\`, and common control chars.
	json_str : Str -> Str
	json_str = |s| {
		escaped = s.to_utf8().fold([], |acc, b|
			if b == 34 acc.concat("\\\"".to_utf8())
			else if b == 92 acc.concat("\\\\".to_utf8())
			else if b == 10 acc.concat("\\n".to_utf8())
			else if b == 13 acc.concat("\\r".to_utf8())
			else if b == 9 acc.concat("\\t".to_utf8())
			else acc.append(b))
		match Str.from_utf8(escaped) {
			Ok(t) => "\"${t}\""
			Err(_) => {
				crash "unreachable: escaping preserves UTF-8 validity"
			}
		}
	}
}

# Tests — expected values mirror what zulip-ts produces (JSON.stringify vectors
# generated with python json.dumps, identical semantics for these cases)

expect
	Messages.send_direct_message([UserId.from(101), UserId.from(102)], "hi there").form_body()
	== "type=direct&to=%5B101%2C102%5D&content=hi+there"

expect
	Messages.send_stream_message(
		ChannelName.from("general chat"),
		TopicName.from("hello world"),
		"a & b",
	).form_body()
	== "type=stream&to=general+chat&subject=hello+world&content=a+%26+b"

expect
	Messages.mark_as_read([MessageId.from(7), MessageId.from(8)]).form_body()
	== "messages=%5B7%2C8%5D&op=add&flag=read"

expect Messages.add_reaction(MessageId.from(99), EmojiName.from("thumbs_up")).path_of() == "/messages/99/reactions"
expect Messages.add_reaction(MessageId.from(99), EmojiName.from("thumbs_up")).method_str() == "POST"
expect Messages.remove_reaction(MessageId.from(99), EmojiName.from("heart")).method_str() == "DELETE"

expect
	Messages.get_message(MessageId.from(31337), False).url("https://chat.example.com")
	== "https://chat.example.com/api/v1/messages/31337?apply_markdown=false"

# narrow JSON matches JSON.stringify exactly
expect
	Messages.json_narrow([Messages.Narrow.by_str("sender", "bot@zulip.example.com")])
	== "[{\"operator\":\"sender\",\"operand\":\"bot@zulip.example.com\"}]"
expect
	Messages.json_narrow([
		Messages.Narrow.by_num("stream", 42),
		Messages.Narrow.by_str("topic", "hello world"),
	])
	== "[{\"operator\":\"stream\",\"operand\":42},{\"operator\":\"topic\",\"operand\":\"hello world\"}]"
expect
	Messages.json_str("say \"hi\"\n")
	== "\"say \\\"hi\\\"\\n\""

expect
	Messages.get_messages({
		anchor: Newest,
		num_before: 100,
		num_after: 0,
		narrow: [Messages.Narrow.by_str("sender", "a@b.c")],
		apply_markdown: False,
	})
		.url("https://chat.example.com")
	== "https://chat.example.com/api/v1/messages?anchor=newest&num_before=100&num_after=0&narrow=%5B%7B%22operator%22%3A%22sender%22%2C%22operand%22%3A%22a%40b.c%22%7D%5D&apply_markdown=false"

expect
	Messages.get_messages({
		anchor: At(MessageId.from(555)),
		num_before: 0,
		num_after: 50,
		narrow: [],
		apply_markdown: True,
	})
		.url("https://x.org")
	== "https://x.org/api/v1/messages?anchor=555&num_before=0&num_after=50&narrow=%5B%5D&apply_markdown=true"
