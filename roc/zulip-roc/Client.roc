## A Zulip API client: connection config plus an injected effectful `send!`.
##
## The package declares no hosted effects — the app supplies the transport at
## construction (e.g. `Client.new(config, ...)` wrapping `Http.send!` on
## basic-cli), which is what keeps this package platform-agnostic. Transport
## errors are erased to `Str` at the injection boundary so the client type
## doesn't depend on any platform's error type; adapt with
## `|req| Http.send!(req).map_err(Str.inspect)`.
##
## Effectful functions here are thin glue over the pure builders/decoders in
## Events and Messages (which carry the test coverage); they're exercised
## end-to-end by the dispatcher app.

import http.Request
import http.Response
import Api
import Base64
import Channels
import Events
import Messages
import Users

Client := {
	site : Str,
	email : Str,
	api_key : Str,
	send! : Request.Request => Try(Response.Response, Str),
}.{

	Config : { site : Str, email : Str, api_key : Str }

	## `site` is the Zulip server URL without a trailing slash,
	## e.g. "https://example.zulipchat.com".
	new : Config, (Request.Request => Try(Response.Response, Str)) -> Client
	new = |config, send!| {
		site: config.site,
		email: config.email,
		api_key: config.api_key,
		send!: send!,
	}

	## The HTTP Basic auth header value for this client's credentials.
	auth_header : Client -> Str
	auth_header = |client|
		"Basic ${Base64.encode_str("${client.email}:${client.api_key}")}"

	## Requests default to NoTimeout, which the host treats as wait-forever —
	## a silently dead connection would block the caller indefinitely. Apply a
	## default so a hung request surfaces as a Transport error instead;
	## requests that set their own timeout are left alone.
	default_timeout_ms : U64
	default_timeout_ms = 30_000

	ensure_timeout : Request.Request -> Request.Request
	ensure_timeout = |req|
		match req.timeout() {
			NoTimeout => req.with_timeout(TimeoutMilliseconds(default_timeout_ms))
			TimeoutMilliseconds(_) => req
		}

	## Apply auth to a request, send it, and return status + body text.
	## Zulip returns error payloads with non-2xx statuses, so callers decode
	## the body regardless of status; transport failures surface as Transport.
	send_authed! : Client, Request.Request => Try({ status : U16, body : Str }, [Transport(Str), ..])
	send_authed! = |client, req| {
		authed = ensure_timeout(req).add_header("Authorization", client.auth_header())
		response = (client.send!)(authed) ? |e| Transport(e)
		Ok({
			status: Response.status(response),
			body: Str.from_utf8_lossy(Response.body(response)),
		})
	}

	## Fetch a single message by id (the requesting user's flags included).
	get_message! : Client, I64 => Try(Messages.Message, [Transport(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	get_message! = |client, message_id| {
		result = client.send_authed!(Messages.get_request(client.site, message_id))?
		Messages.decode_message(result.body)
	}

	## Fetch a single message with sender and content (reaction notifications).
	get_full_message! : Client, I64 => Try(Messages.FullMessage, [Transport(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	get_full_message! = |client, message_id| {
		result = client.send_authed!(Messages.get_request(client.site, message_id))?
		Messages.decode_full_message(result.body)
	}

	## Mark messages as read for this client's user.
	mark_read! : Client, List(I64) => Try({}, [Transport(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	mark_read! = |client, message_ids| {
		result = client.send_authed!(Messages.flags_request(client.site, { message_ids, op: "add", flag: "read" }))?
		Api.decode_ack(result.body)
	}

	## Set a topic's visibility policy for this client's user (see
	## Events.followed_policy / Events.inherit_policy).
	set_topic_visibility! : Client, { stream_id : I64, topic : Str, visibility_policy : I64 } => Try({}, [Transport(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	set_topic_visibility! = |client, opts| {
		result = client.send_authed!(Events.set_visibility_request(client.site, opts))?
		Api.decode_ack(result.body)
	}

	## Fetch the realm member list.
	list_members! : Client => Try(List(Users.Member), [Transport(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	list_members! = |client| {
		result = client.send_authed!(Users.list_request(client.site))?
		Users.decode_members(result.body)
	}

	## Fetch the channel list.
	list_channels! : Client => Try(List(Channels.Channel), [Transport(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	list_channels! = |client| {
		result = client.send_authed!(Channels.list_request(client.site))?
		Channels.decode_channels(result.body)
	}
}

# --- tests ---

expect
	Client.new(
		{ site: "https://x.zulipchat.com", email: "bot@x.com", api_key: "k3y" },
		|_req| Ok(Response.from_status(200)),
	).auth_header()
		== "Basic ${Base64.encode_str("bot@x.com:k3y")}"

# a request without a timeout gets the default; an explicit one is kept
expect
	Client.ensure_timeout(Request.from_method(GET)).timeout()
		== TimeoutMilliseconds(30_000)
expect
	Client.ensure_timeout(Request.from_method(GET).with_timeout(TimeoutMilliseconds(5))).timeout()
		== TimeoutMilliseconds(5)
