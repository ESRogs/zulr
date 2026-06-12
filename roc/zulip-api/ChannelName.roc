## Branded Zulip channel (stream) name. See UserId.roc for the pattern rationale.

ChannelName :: [Name(Str)].{
	from_quote : List(U8) -> Try(ChannelName, [BadQuotedBytes(Str)])
	from_quote = |bytes|
		match Str.from_utf8(bytes) {
			Ok(s) => Ok(Name(s))
			Err(_) => Err(BadQuotedBytes("ChannelName literal must be valid UTF-8"))
		}

	from : Str -> ChannelName
	from = |s| Name(s)

	to_str : ChannelName -> Str
	to_str = |name| match name {
		Name(s) => s
	}
}

expect ChannelName.from("general").to_str() == "general"
expect
	{
		channel : ChannelName
		channel = "general"
		channel.to_str() == "general"
	}
