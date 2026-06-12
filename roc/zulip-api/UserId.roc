## Branded Zulip user ID (mirrors `Tagged<number, 'UserId'>` in zulip-ts).
##
## Opaque (`::`): outside this module the only ways to construct one are
## `UserId.from(n)` and plain literals, and the only ways to read one are
## `to_u64()`/`serialize()`. No cast or structural value bypasses the brand,
## and passing a UserId where another branded ID is expected is a type error.
##
## Literals construct it directly wherever the expected type is known,
## checked at compile time:
##
##     sender : UserId
##     sender = 101
##
## `from_numeral` below is a dispatch hook the compiler calls for numeric
## literals; user code never invokes it. The single-tag-union backing
## (`[Id(U64)]`) is the supported idiom for wrapping a scalar — bare scalar
## backing (`UserId := U64`) has no construction path as of roc 5a8047b8.
## All other branded ID modules in this package follow this same pattern.

UserId :: [Id(U64)].{
	from_numeral : Numeral -> Try(UserId, [InvalidNumeral(Str), ..])
	from_numeral = |numeral|
		match U64.from_numeral(numeral) {
			Ok(n) => Ok(Id(n))
			Err(e) => Err(e)
		}

	from : U64 -> UserId
	from = |n| Id(n)

	to_u64 : UserId -> U64
	to_u64 = |id| match id {
		Id(n) => n
	}

	serialize : UserId -> Str
	serialize = |id| id.to_u64().to_str()
}

expect UserId.from(7).to_u64() == 7
expect UserId.from(7).serialize() == "7"
expect
	{
		sender : UserId
		sender = 101
		sender.to_u64() == 101
	}
