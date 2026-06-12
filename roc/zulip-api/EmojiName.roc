## Branded Zulip emoji name (e.g. "thumbs_up"). See UserId.roc for the pattern rationale.

EmojiName :: [Name(Str)].{
	from_quote : List(U8) -> Try(EmojiName, [BadQuotedBytes(Str)])
	from_quote = |bytes|
		match Str.from_utf8(bytes) {
			Ok(s) => Ok(Name(s))
			Err(_) => Err(BadQuotedBytes("EmojiName literal must be valid UTF-8"))
		}

	from : Str -> EmojiName
	from = |s| Name(s)

	to_str : EmojiName -> Str
	to_str = |name| match name {
		Name(s) => s
	}
}

expect EmojiName.from("thumbs_up").to_str() == "thumbs_up"
