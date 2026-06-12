## Pure HTTP request descriptor for the Zulip API, ported from the pure parts
## of zulip-ts/src/client.ts.
##
## Gleam-style split: this library only *describes* requests (method, path,
## payload) and prepares everything the host needs to send them (URL, headers,
## encoded form body). The actual HTTP send is the host's job.
##
## The payload is a tag union — a request carries query params *or* a form
## body, never both, so the GET-with-body confusion in the original TS
## RequestOptions is unrepresentable here.
##
## Pairs are ordered (Str, Str) lists, not Dicts: order is preserved and
## duplicate keys are representable, so no information is discarded before
## the wire.

import Base64
import FormUrlEncoded
import ApiKey
import Email

Request := {
	method : [Get, Post, Delete, Patch],
	path : Str,
	payload : [Query(List((Str, Str))), Form(List((Str, Str)))],
}.{

	get : Str, List((Str, Str)) -> Request
	get = |path, params| { method: Get, path: path, payload: Query(params) }

	post : Str, List((Str, Str)) -> Request
	post = |path, body| { method: Post, path: path, payload: Form(body) }

	patch : Str, List((Str, Str)) -> Request
	patch = |path, body| { method: Patch, path: path, payload: Form(body) }

	delete : Str, List((Str, Str)) -> Request
	delete = |path, body| { method: Delete, path: path, payload: Form(body) }

	## The API path (no /api/v1 prefix), e.g. "/messages/7/reactions".
	path_of : Request -> Str
	path_of = |req| req.path

	## Wire name of the HTTP method.
	method_str : Request -> Str
	method_str = |req|
		match req.method {
			Get => "GET"
			Post => "POST"
			Patch => "PATCH"
			Delete => "DELETE"
		}

	## Full URL: site (trailing slashes stripped) + /api/v1 + path + ?query.
	url : Request, Str -> Str
	url = |req, site| {
		base = "${strip_trailing_slashes(site)}/api/v1${req.path}"
		match req.payload {
			Query([]) => base
			Query(params) => "${base}?${FormUrlEncoded.encode_pairs(params)}"
			Form(_) => base
		}
	}

	## All headers the host must set: Basic auth + Content-Type when a form
	## body is present.
	headers : Request, Email, ApiKey -> List((Str, Str))
	headers = |req, email, api_key|
		[auth_header(email, api_key)].concat(content_type(req))

	## The Basic auth header pair, matching client.ts encodeAuth/authHeaders.
	auth_header : Email, ApiKey -> (Str, Str)
	auth_header = |email, api_key| {
		credentials = "${email.to_str()}:${api_key.to_str()}"
		("Authorization", "Basic ${Base64.encode_str(credentials)}")
	}

	## Form-encoded request body ("" when there is none).
	form_body : Request -> Str
	form_body = |req|
		match req.payload {
			Query(_) => ""
			Form(body) => FormUrlEncoded.encode_pairs(body)
		}

	## Content-Type header pairs to add (empty when there is no form body).
	content_type : Request -> List((Str, Str))
	content_type = |req|
		match req.payload {
			Query(_) => []
			Form([]) => []
			Form(_) => [("Content-Type", "application/x-www-form-urlencoded")]
		}

	strip_trailing_slashes : Str -> Str
	strip_trailing_slashes = |s|
		if s.ends_with("/") strip_trailing_slashes(s.drop_suffix("/"))
		else s
}

# Tests — behavior matches zulip-ts/src/client.ts

# URL building: /api/v1 prefix, trailing-slash stripping, query encoding
expect Request.get("/messages", []).url("https://chat.example.com") == "https://chat.example.com/api/v1/messages"
expect Request.get("/messages", []).url("https://chat.example.com//") == "https://chat.example.com/api/v1/messages"
expect
	Request.get("/messages", [("anchor", "newest"), ("num_before", "100")]).url("https://chat.example.com")
	== "https://chat.example.com/api/v1/messages?anchor=newest&num_before=100"
# params needing encoding
expect
	Request.get("/messages", [("narrow", "[{\"operator\":\"sender\"}]")]).url("https://x.org")
	== "https://x.org/api/v1/messages?narrow=%5B%7B%22operator%22%3A%22sender%22%7D%5D"
# form payloads never leak into the URL
expect Request.post("/messages", [("type", "direct")]).url("https://x.org") == "https://x.org/api/v1/messages"

# POST bodies are form-encoded; GETs have empty body
expect
	Request.post("/messages", [("type", "direct"), ("content", "hi there")]).form_body()
	== "type=direct&content=hi+there"
expect Request.get("/messages", []).form_body() == ""

# method wire names
expect Request.post("/messages", []).method_str() == "POST"
expect Request.patch("/messages/7", []).method_str() == "PATCH"
expect Request.delete("/messages/7/reactions", []).method_str() == "DELETE"

# content-type only when a non-empty form body is present
expect Request.post("/messages", [("a", "b")]).content_type() == [("Content-Type", "application/x-www-form-urlencoded")]
expect Request.post("/messages", []).content_type() == []
expect Request.get("/messages", []).content_type() == []

# auth header — base64 vector generated with python3 base64.b64encode
expect
	Request.auth_header(Email.from("bot@zulip.example.com"), ApiKey.from("abc123secret"))
	== ("Authorization", "Basic Ym90QHp1bGlwLmV4YW1wbGUuY29tOmFiYzEyM3NlY3JldA==")

# headers(): auth always, content-type only with a form body
expect
	Request.post("/messages", [("a", "b")]).headers(Email.from("e@x.com"), ApiKey.from("k"))
	== [
		("Authorization", "Basic ZUB4LmNvbTpr"),
		("Content-Type", "application/x-www-form-urlencoded"),
	]
expect
	Request.get("/messages", []).headers(Email.from("e@x.com"), ApiKey.from("k"))
	== [("Authorization", "Basic ZUB4LmNvbTpr")]
