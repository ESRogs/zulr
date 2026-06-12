## Branded Zulip API key. See UserId.roc for the pattern rationale.

ApiKey :: [Key(Str)].{
	from_quote : List(U8) -> Try(ApiKey, [BadQuotedBytes(Str)])
	from_quote = |bytes|
		match Str.from_utf8(bytes) {
			Ok(s) => Ok(Key(s))
			Err(_) => Err(BadQuotedBytes("ApiKey literal must be valid UTF-8"))
		}

	from : Str -> ApiKey
	from = |s| Key(s)

	to_str : ApiKey -> Str
	to_str = |key| match key {
		Key(s) => s
	}
}

expect ApiKey.from("abc123").to_str() == "abc123"
