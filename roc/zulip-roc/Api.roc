## Shared response-handling helpers for the Zulip REST API.
##
## Every Zulip endpoint returns `{"result": "success", ...}` on success and
## `{"result": "error", "msg": ..., "code": ...}` on failure (with `code`
## sometimes absent). Decoders in this package parse the success shape first
## and fall back to the error shape, so callers get a typed
## `ApiError({ code, msg })` for things like BAD_EVENT_QUEUE_ID.

Api := [].{

	ErrorBody : { code : Str, msg : Str }

	## Decode a Zulip error response body. Returns NotAnApiError if the body
	## isn't a `{"result": "error"}` payload.
	decode_error : Str -> Try(ErrorBody, [NotAnApiError])
	decode_error = |raw| {
		base : Try({ result : Str, msg : Str }, _)
		base = Json.parse(raw)
		match base {
			Ok({ result, msg }) => {
				if result == "error" {
					# `code` is not always present, so probe for it separately.
					with_code : Try({ code : Str }, _)
					with_code = Json.parse(raw)
					code = match with_code {
						Ok(c) => c.code
						Err(_) => "UNKNOWN_ERROR"
					}
					Ok({ code, msg })
				} else {
					Err(NotAnApiError)
				}
			}
			Err(_) => Err(NotAnApiError)
		}
	}

	## Interpret a decode failure: prefer the typed API error if the body is
	## one, otherwise report the body as undecodable.
	decode_failure : Str -> [ApiError(ErrorBody), BadResponse(Str), ..]
	decode_failure = |body|
		match decode_error(body) {
			Ok(err_body) => ApiError(err_body)
			Err(NotAnApiError) => BadResponse(body)
		}

	## Decode a response whose only interesting content is success/failure.
	## Only a real success payload is Ok; an error payload is ApiError and
	## anything else (e.g. a proxy's HTML 502) is BadResponse.
	decode_ack : Str -> Try({}, [ApiError(ErrorBody), BadResponse(Str), ..])
	decode_ack = |body|
		match decode_error(body) {
			Ok(err_body) => Err(ApiError(err_body))
			Err(NotAnApiError) => {
				probe : Try({ result : Str }, _)
				probe = Json.parse(body)
				match probe {
					Ok(p) => if p.result == "success" Ok({}) else Err(BadResponse(body))
					Err(_) => Err(BadResponse(body))
				}
			}
		}
}

expect Api.decode_error("{\"result\": \"error\", \"msg\": \"Bad event queue ID\", \"code\": \"BAD_EVENT_QUEUE_ID\"}") == Ok({ code: "BAD_EVENT_QUEUE_ID", msg: "Bad event queue ID" })

expect Api.decode_ack("{\"result\":\"success\",\"msg\":\"\"}") == Ok({})
expect Api.decode_ack("{\"result\":\"error\",\"msg\":\"no\",\"code\":\"BAD_REQUEST\"}") == Err(ApiError({ code: "BAD_REQUEST", msg: "no" }))
expect Api.decode_ack("<html>502</html>") == Err(BadResponse("<html>502</html>"))

# an error body whose msg contains escapes decodes them faithfully
expect
	Api.decode_error("{\"result\": \"error\", \"msg\": \"bad \\\"input\\\"\", \"code\": \"BAD_REQUEST\"}")
		== Ok({ code: "BAD_REQUEST", msg: "bad \"input\"" })
expect Api.decode_error("{\"result\": \"error\", \"msg\": \"oops\"}") == Ok({ code: "UNKNOWN_ERROR", msg: "oops" })
expect Api.decode_error("{\"result\": \"success\", \"msg\": \"\"}") == Err(NotAnApiError)
expect Api.decode_error("not json") == Err(NotAnApiError)

expect Api.decode_failure("{\"result\": \"error\", \"msg\": \"gone\", \"code\": \"BAD_EVENT_QUEUE_ID\"}") == ApiError({ code: "BAD_EVENT_QUEUE_ID", msg: "gone" })
expect Api.decode_failure("<html>502</html>") == BadResponse("<html>502</html>")
