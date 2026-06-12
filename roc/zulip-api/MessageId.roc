## Branded Zulip message ID. See UserId.roc for the pattern rationale.

MessageId :: [Id(U64)].{
	from_numeral : Numeral -> Try(MessageId, [InvalidNumeral(Str), ..])
	from_numeral = |numeral|
		match U64.from_numeral(numeral) {
			Ok(n) => Ok(Id(n))
			Err(e) => Err(e)
		}

	from : U64 -> MessageId
	from = |n| Id(n)

	to_u64 : MessageId -> U64
	to_u64 = |id| match id {
		Id(n) => n
	}

	serialize : MessageId -> Str
	serialize = |id| id.to_u64().to_str()
}

expect MessageId.from(123456).serialize() == "123456"
expect
	{
		id : MessageId
		id = 42
		id.to_u64() == 42
	}
