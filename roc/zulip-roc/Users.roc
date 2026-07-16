## Request builder and decoder for GET /api/v1/users — the realm member
## list, used to resolve user ids to display names (e.g. naming the reactor
## in a reaction notification).

import http.Request
import Api

Users := [].{

	Member : { user_id : I64, full_name : Str, email : Str, is_bot : Bool }

	list_request : Str -> Request.Request
	list_request = |base|
		Request.from_method(GET).with_uri("${base}/api/v1/users")

	decode_members : Str -> Try(List(Member), [ApiError(Api.ErrorBody), BadResponse(Str), ..])
	decode_members = |raw| {
		parsed : Try({ members : List(Member) }, _)
		parsed = Json.parse(raw)
		match parsed {
			Ok({ members }) => Ok(members)
			Err(_) => Err(Api.decode_failure(raw))
		}
	}
}

# --- tests ---

expect
	Users.list_request("https://x.zulipchat.com").uri() == "https://x.zulipchat.com/api/v1/users"

expect
	Users.decode_members("{\"result\":\"success\",\"members\":[{\"user_id\":9,\"full_name\":\"Reba\",\"email\":\"reba@x.com\",\"is_bot\":false,\"avatar_url\":null}]}")
		== Ok([{ user_id: 9, full_name: "Reba", email: "reba@x.com", is_bot: Bool.False }])

expect
	Users.decode_members("{\"result\":\"error\",\"msg\":\"nope\",\"code\":\"BAD_REQUEST\"}")
		== Err(ApiError({ code: "BAD_REQUEST", msg: "nope" }))
