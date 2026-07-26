## Base64 encoding (RFC 4648, standard alphabet, with padding).
## Matches JS `btoa` semantics for byte input — used for HTTP Basic auth.

Base64 := [].{

	## Encode a string's UTF-8 bytes as base64.
	encode_str : Str -> Str
	encode_str = |s|
		encode(Str.to_utf8(s))

	## Encode raw bytes as base64.
	encode : List(U8) -> Str
	encode = |bytes| {
		out = encode_chunks(bytes, [])
		match Str.from_utf8(out) {
			Ok(s) => s
			Err(_) => {
				crash "unreachable: base64 output is always ASCII"
			}
		}
	}

	## Process input 3 bytes at a time, emitting 4 output characters per group.
	encode_chunks : List(U8), List(U8) -> List(U8)
	encode_chunks = |bytes, acc|
		match bytes {
			[] => acc
			[a] => {
				i0 = a.shr_wrap(2)
				i1 = a.bitwise_and(3).shl_wrap(4)
				acc.append(char_at(i0)).append(char_at(i1)).append(61).append(61)
			}
			[a, b] => {
				i0 = a.shr_wrap(2)
				i1 = a.bitwise_and(3).shl_wrap(4).bitwise_or(b.shr_wrap(4))
				i2 = b.bitwise_and(15).shl_wrap(2)
				acc.append(char_at(i0)).append(char_at(i1)).append(char_at(i2)).append(61)
			}
			[a, b, c, .. as rest] => {
				i0 = a.shr_wrap(2)
				i1 = a.bitwise_and(3).shl_wrap(4).bitwise_or(b.shr_wrap(4))
				i2 = b.bitwise_and(15).shl_wrap(2).bitwise_or(c.shr_wrap(6))
				i3 = c.bitwise_and(63)
				next = acc.append(char_at(i0)).append(char_at(i1)).append(char_at(i2)).append(char_at(i3))
				encode_chunks(rest, next)
			}
		}

	## The standard base64 alphabet, as bytes.
	alphabet : List(U8)
	alphabet = Str.to_utf8("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

	## Look up an index (0-63) in the standard base64 alphabet.
	char_at : U8 -> U8
	char_at = |i|
		match alphabet.get(i.to_u64()) {
			Ok(c) => c
			Err(_) => {
				crash "unreachable: base64 index is always 0-63"
			}
		}
}

# Tests — RFC 4648 section 10 test vectors
expect Base64.encode_str("") == ""
expect Base64.encode_str("f") == "Zg=="
expect Base64.encode_str("fo") == "Zm8="
expect Base64.encode_str("foo") == "Zm9v"
expect Base64.encode_str("foob") == "Zm9vYg=="
expect Base64.encode_str("fooba") == "Zm9vYmE="
expect Base64.encode_str("foobar") == "Zm9vYmFy"

# Basic-auth shaped input
expect Base64.encode_str("user@example.com:secret") == "dXNlckBleGFtcGxlLmNvbTpzZWNyZXQ="
