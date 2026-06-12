## Branded email address (login or API email). See UserId.roc for the pattern rationale.

Email :: [Email(Str)].{
	from_quote : List(U8) -> Try(Email, [BadQuotedBytes(Str)])
	from_quote = |bytes|
		match Str.from_utf8(bytes) {
			Ok(s) => Ok(Email(s))
			Err(_) => Err(BadQuotedBytes("Email literal must be valid UTF-8"))
		}

	from : Str -> Email
	from = |s| Email(s)

	to_str : Email -> Str
	to_str = |email| match email {
		Email(s) => s
	}
}

expect Email.from("bot@example.com").to_str() == "bot@example.com"
