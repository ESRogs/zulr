## Request builder and decoder for GET /api/v1/streams — the channel list,
## used to resolve stream ids to names (message events carry stream_id, but
## their display_recipient field can't be batch-decoded; see
## Events.InboundMessage).

import http.Request
import Api

Channels := [].{

	Channel : { stream_id : I64, name : Str }

	list_request : Str -> Request.Request
	list_request = |base|
		Request.from_method(GET).with_uri("${base}/api/v1/streams")

	decode_channels : Str -> Try(List(Channel), [ApiError(Api.ErrorBody), BadResponse(Str), ..])
	decode_channels = |raw| {
		parsed : Try({ streams : List(Channel) }, _)
		parsed = Json.parse(raw)
		match parsed {
			Ok({ streams }) => Ok(streams)
			Err(_) => Err(Api.decode_failure(raw))
		}
	}
}

# --- tests ---

expect
	Channels.list_request("https://x.zulipchat.com").uri() == "https://x.zulipchat.com/api/v1/streams"

expect
	Channels.decode_channels("{\"result\":\"success\",\"streams\":[{\"stream_id\":7,\"name\":\"general\",\"description\":\"\"}]}")
		== Ok([{ stream_id: 7, name: "general" }])

expect
	Channels.decode_channels("{\"result\":\"error\",\"msg\":\"nope\",\"code\":\"BAD_REQUEST\"}")
		== Err(ApiError({ code: "BAD_REQUEST", msg: "nope" }))
