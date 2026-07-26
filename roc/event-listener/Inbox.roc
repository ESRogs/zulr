## Pure helpers for appending to Claude Code teammate inbox files
## (~/.claude/teams/<team>/inboxes/<name>.json). Only the append side lives
## here — consuming inbox messages stays in the TS MCP server.
##
## Existing file content is never re-encoded: the new entry is spliced into
## the JSON array textually, so entries written by other producers (Claude
## Code's own team runtime) survive even when they carry fields this module
## doesn't know about. All effects (file IO, clock) belong to the caller.

Inbox := [].{

	## One inbox entry, before serialization. `context` distinguishes stream
	## messages (which carry zulipStream/zulipTopic) from DMs (which don't).
	Entry : {
		from : Str,
		text : Str,
		summary : Str,
		timestamp_iso : Str,
		zulip_message_id : I64,
		zulip_sender_id : I64,
		context : [InStream({ stream : Str, topic : Str }), InDm],
		zulip_sender : Str,
	}

	## Serialize an entry as a single-line JSON object (field names and order
	## match the TS writer; `read` starts false).
	entry_json : Entry -> Str
	entry_json = |entry| {
		stream_fields = match entry.context {
			InStream({ stream, topic }) =>
				"\"zulipStream\":${json_str(stream)},\"zulipTopic\":${json_str(topic)},"
			InDm => ""
		}
		Str.join_with(
			[
				"{\"from\":${json_str(entry.from)},",
				"\"text\":${json_str(entry.text)},",
				"\"summary\":${json_str(entry.summary)},",
				"\"zulipMessageId\":${I64.to_str(entry.zulip_message_id)},",
				"\"zulipSenderId\":${I64.to_str(entry.zulip_sender_id)},",
				stream_fields,
				"\"zulipSender\":${json_str(entry.zulip_sender)},",
				"\"timestamp\":${json_str(entry.timestamp_iso)},",
				"\"read\":false}",
			],
			"",
		)
	}

	## Splice a serialized entry into a JSON array's text without re-encoding
	## the existing elements. Accepts an empty string as an empty array.
	append_to_array : Str, Str -> Try(Str, [NotAnArray])
	append_to_array = |content, element| {
		trimmed = Str.trim(content)
		if trimmed == "" or trimmed == "[]" {
			Ok("[\n${element}\n]")
		} else if trimmed.ends_with("]") {
			body = trimmed.drop_suffix("]").trim_end()
			if body.ends_with("[") {
				# array containing only whitespace
				Ok("${body}\n${element}\n]")
			} else {
				Ok("${body},\n${element}\n]")
			}
		} else {
			Err(NotAnArray)
		}
	}

	## Whether the inbox JSON already holds an entry for this Zulip message
	## (prevents duplicate delivery). Undecodable content reads as
	## not-present; append_to_array is what rejects non-arrays.
	has_message_id : Str, I64 -> Bool
	has_message_id = |content, message_id| {
		trimmed = Str.trim(content)
		if trimmed == "" {
			Bool.False
		} else {
			parsed : Try(List({ zulipMessageId : Try(I64, [Missing]) }), _)
			parsed = Json.parse(trimmed)
			match parsed {
				Ok(entries) => entries.any(|e| e.zulipMessageId == Ok(message_id))
				Err(_) => Bool.False
			}
		}
	}

	## Truncate to at most `max_bytes` UTF-8 bytes, cutting only at codepoint
	## boundaries, with a "..." suffix when anything was dropped.
	truncate : Str, U64 -> Str
	truncate = |s, max_bytes| {
		bytes = Str.to_utf8(s)
		if bytes.len() <= max_bytes {
			s
		} else {
			cut = last_boundary_at_or_before(bytes, max_bytes)
			prefix = Str.from_utf8_lossy(bytes.take_first(cut))
			"${prefix}..."
		}
	}

	## Largest index <= limit that starts a codepoint (never lands mid-char).
	last_boundary_at_or_before : List(U8), U64 -> U64
	last_boundary_at_or_before = |bytes, limit| {
		var $index = limit
		while $index > 0 and is_continuation(bytes.get($index) ?? 0) {
			$index = $index - 1
		}
		$index
	}

	is_continuation : U8 -> Bool
	is_continuation = |byte| byte.bitwise_and(0xC0) == 0x80

	## Replace straight double quotes with alternating curly quotes — straight
	## quotes in the summary field break Claude Code's UI display.
	sanitize_summary : Str -> Str
	sanitize_summary = |s| {
		bytes = Str.to_utf8(s)
		var $out = List.with_capacity(bytes.len())
		var $open = Bool.True
		for byte in bytes {
			if byte == 34 {
				$out = $out.concat(
					if $open {
						Str.to_utf8("\u(201C)")
					} else {
						Str.to_utf8("\u(201D)")
					},
				)
				$open = !$open
			} else {
				$out = $out.append(byte)
			}
		}
		Str.from_utf8_lossy($out)
	}

	## The message footer appended to inbox text: [msg:ID ts:ISO].
	format_footer : I64, Str -> Str
	format_footer = |message_id, timestamp_iso| "[msg:${I64.to_str(message_id)} ts:${timestamp_iso}]"

	## JSON-encode a string (quoted, escaped).
	json_str : Str -> Str
	json_str = |s|
		match Json.to_str_try(s) {
			Ok(encoded) => encoded
			Err(_) => {
				crash "unreachable: encoding Str to JSON cannot fail"
			}
		}
}

# --- tests ---

expect Inbox.json_str("say \"hi\"\nnow") == "\"say \\\"hi\\\"\\nnow\""

expect
	Inbox.entry_json({
		from: "zulip:general/pr-9:Ada",
		text: "nice \"work\"\n[msg:77 ts:2026-07-16T00:00:00.000Z]",
		summary: "nice \u(201C)work\u(201D)",
		timestamp_iso: "2026-07-16T01:02:03.000Z",
		zulip_message_id: 77,
		zulip_sender_id: 5,
		context: InStream({ stream: "general", topic: "pr-9" }),
		zulip_sender: "Ada",
	})
		== "{\"from\":\"zulip:general/pr-9:Ada\",\"text\":\"nice \\\"work\\\"\\n[msg:77 ts:2026-07-16T00:00:00.000Z]\",\"summary\":\"nice \u(201C)work\u(201D)\",\"zulipMessageId\":77,\"zulipSenderId\":5,\"zulipStream\":\"general\",\"zulipTopic\":\"pr-9\",\"zulipSender\":\"Ada\",\"timestamp\":\"2026-07-16T01:02:03.000Z\",\"read\":false}"

# DM entries carry no stream fields
expect
	Inbox.entry_json({
		from: "zulip:Bo",
		text: "psst",
		summary: "psst",
		timestamp_iso: "2026-07-16T01:02:03.000Z",
		zulip_message_id: 78,
		zulip_sender_id: 6,
		context: InDm,
		zulip_sender: "Bo",
	})
		== "{\"from\":\"zulip:Bo\",\"text\":\"psst\",\"summary\":\"psst\",\"zulipMessageId\":78,\"zulipSenderId\":6,\"zulipSender\":\"Bo\",\"timestamp\":\"2026-07-16T01:02:03.000Z\",\"read\":false}"

expect Inbox.append_to_array("", "{\"a\":1}") == Ok("[\n{\"a\":1}\n]")
expect Inbox.append_to_array("[]", "{\"a\":1}") == Ok("[\n{\"a\":1}\n]")
expect Inbox.append_to_array("[ \n]", "{\"a\":1}") == Ok("[\n{\"a\":1}\n]")
expect
	Inbox.append_to_array("[\n{\"a\":1}\n]", "{\"b\":2}")
		== Ok("[\n{\"a\":1},\n{\"b\":2}\n]")
expect Inbox.append_to_array("not json", "{\"a\":1}") == Err(NotAnArray)

# splice keeps existing entries byte-identical, including fields we don't model
expect
	Inbox.append_to_array("[\n  {\"from\":\"x\",\"mystery\":true}\n]", "{\"b\":2}")
		== Ok("[\n  {\"from\":\"x\",\"mystery\":true},\n{\"b\":2}\n]")

expect Inbox.has_message_id("[{\"zulipMessageId\":77,\"read\":true}]", 77)
expect !Inbox.has_message_id("[{\"zulipMessageId\":77}]", 78)
# entries without a zulipMessageId (e.g. SendMessage entries) don't match
expect !Inbox.has_message_id("[{\"from\":\"teammate\",\"text\":\"hi\"}]", 77)
expect !Inbox.has_message_id("", 77)
expect !Inbox.has_message_id("corrupt", 77)

expect Inbox.truncate("hello", 60) == "hello"
expect Inbox.truncate("hello world", 5) == "hello..."
# never cuts mid-codepoint: é is 2 bytes starting at index 3
expect Inbox.truncate("caf\u(E9) au lait", 4) == "caf..."

expect Inbox.sanitize_summary("say \"hi\" and \"bye\"") == "say \u(201C)hi\u(201D) and \u(201C)bye\u(201D)"
expect Inbox.sanitize_summary("no quotes") == "no quotes"

expect Inbox.format_footer(77, "2026-07-16T01:02:03.000Z") == "[msg:77 ts:2026-07-16T01:02:03.000Z]"
