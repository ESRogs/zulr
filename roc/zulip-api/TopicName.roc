## Branded Zulip topic name. See UserId.roc for the pattern rationale.

TopicName :: [Name(Str)].{
	from_quote : List(U8) -> Try(TopicName, [BadQuotedBytes(Str)])
	from_quote = |bytes|
		match Str.from_utf8(bytes) {
			Ok(s) => Ok(Name(s))
			Err(_) => Err(BadQuotedBytes("TopicName literal must be valid UTF-8"))
		}

	from : Str -> TopicName
	from = |s| Name(s)

	to_str : TopicName -> Str
	to_str = |name| match name {
		Name(s) => s
	}
}

expect TopicName.from("greetings").to_str() == "greetings"
