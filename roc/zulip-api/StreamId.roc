## Branded Zulip stream/channel ID. See UserId.roc for the pattern rationale.

StreamId :: [Id(U64)].{
	from_numeral : Numeral -> Try(StreamId, [InvalidNumeral(Str), ..])
	from_numeral = |numeral|
		match U64.from_numeral(numeral) {
			Ok(n) => Ok(Id(n))
			Err(e) => Err(e)
		}

	from : U64 -> StreamId
	from = |n| Id(n)

	to_u64 : StreamId -> U64
	to_u64 = |id| match id {
		Id(n) => n
	}

	serialize : StreamId -> Str
	serialize = |id| id.to_u64().to_str()
}

expect StreamId.from(9).serialize() == "9"
