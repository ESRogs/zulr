## application/x-www-form-urlencoded serialization, matching the WHATWG URL
## spec (and therefore JS `URLSearchParams`): A-Z a-z 0-9 `*` `-` `.` `_` are
## left bare, space becomes `+`, every other UTF-8 byte becomes %XX (uppercase).

FormUrlEncoded := [].{

	## Percent-encode a single key or value.
	encode_value : Str -> Str
	encode_value = |s| {
		out = Str.to_utf8(s).fold([], encode_byte)
		match Str.from_utf8(out) {
			Ok(t) => t
			Err(_) => {
				crash "unreachable: form-urlencoded output is always ASCII"
			}
		}
	}

	## Serialize key-value pairs as `k1=v1&k2=v2`, preserving order and duplicates.
	encode_pairs : List((Str, Str)) -> Str
	encode_pairs = |pairs|
		Str.join_with(
			pairs.map(|(k, v)| "${encode_value(k)}=${encode_value(v)}"),
			"&",
		)

	encode_byte : List(U8), U8 -> List(U8)
	encode_byte = |acc, b|
		if is_unreserved(b) {
			acc.append(b)
		} else if b == 32 {
			acc.append(43) # space -> '+'
		} else {
			acc.append(37).append(hex_digit(b.shift_right_by(4))).append(hex_digit(b.bitwise_and(15)))
		}

	## WHATWG urlencoded-serializer leaves these bytes bare: A-Z a-z 0-9 * - . _
	is_unreserved : U8 -> Bool
	is_unreserved = |b|
		(b >= 48 and b <= 57)
			or (b >= 65 and b <= 90)
				or (b >= 97 and b <= 122)
					or b == 42
						or b == 45
							or b == 46
								or b == 95

	hex_digit : U8 -> U8
	hex_digit = |n| if n < 10 (n + 48) else (n + 55)
}

# Tests — cross-checked against JS `new URLSearchParams(...).toString()`
expect FormUrlEncoded.encode_value("") == ""
expect FormUrlEncoded.encode_value("abcXYZ019") == "abcXYZ019"
expect FormUrlEncoded.encode_value("a b") == "a+b"
expect FormUrlEncoded.encode_value("*-._") == "*-._"
expect FormUrlEncoded.encode_value("a&b=c") == "a%26b%3Dc"
expect FormUrlEncoded.encode_value("100%") == "100%25"
expect FormUrlEncoded.encode_value("user@example.com") == "user%40example.com"
expect FormUrlEncoded.encode_value("~!()'") == "%7E%21%28%29%27"
# UTF-8 multibyte: e-acute and snowman
expect FormUrlEncoded.encode_value("é") == "%C3%A9"
expect FormUrlEncoded.encode_value("☃") == "%E2%98%83"

expect FormUrlEncoded.encode_pairs([]) == ""
expect FormUrlEncoded.encode_pairs([("type", "direct")]) == "type=direct"
expect
	FormUrlEncoded.encode_pairs([("to", "general chat"), ("content", "hi & bye")])
		== "to=general+chat&content=hi+%26+bye"
# duplicate keys preserved in order (why this is a List, not a Dict)
expect
	FormUrlEncoded.encode_pairs([("k", "1"), ("k", "2")])
		== "k=1&k=2"
