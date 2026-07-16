## Event-queue session lifecycle over a Client: register a queue, poll it
## without blocking, delete it.
##
## `poll!` is the primitive — it returns new event metadata and the advanced
## session, and the app owns the outer loop (round-robin across N sessions
## with a sleep between sweeps; the platform has no concurrency primitives,
## so held long-poll connections are not an option).
##
## On BAD_EVENT_QUEUE_ID (queue expired or server restarted), `poll!` returns
## `Err(QueueInvalid(...))` — re-register and continue. Re-registering also
## refreshes `user_topics` (the followed-topic snapshot), so callers should
## re-register periodically even without errors; queue events only include
## message events, not follow-state changes.
##
## Effectful functions are thin glue over pure helpers (tested below) and the
## Events builders/decoders; they're exercised end-to-end by the dispatcher.

import Api
import Client
import Events

Session := {
	queue_id : Str,
	last_event_id : I64,
	user_topics : List(Events.UserTopic),
}.{

	## Register a new event queue. The caller chooses which event types to
	## stream and which initial state to fetch (include "user_topic" in
	## fetch_event_types to get the user_topics snapshot; it decodes as []
	## when absent).
	register! : Client.Client, Events.RegisterOptions => Try(Session, [Transport(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	register! = |client, opts| {
		result = client.send_authed!(Events.register_request(client.site, opts))?
		registered = Events.decode_registered(result.body)?
		Ok({
			queue_id: registered.queue_id,
			last_event_id: registered.last_event_id,
			user_topics: registered.user_topics,
		})
	}

	## Non-blocking poll. Returns the session advanced past all returned
	## events, plus the decoded batch. QueueInvalid means: re-register.
	poll! : Client.Client, Session => Try((Session, Events.Polled), [Transport(Str), QueueInvalid(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	poll! = |client, session| {
		req = Events.poll_request(client.site, session.queue_id, session.last_event_id)
		result = client.send_authed!(req)?
		polled = Events.decode_poll(result.body) ? classify_poll_error
		Ok(({ ..session, last_event_id: next_cursor(session.last_event_id, polled.events) }, polled))
	}

	## Delete the queue server-side (best-effort cleanup on shutdown).
	delete! : Client.Client, Session => Try({}, [Transport(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..])
	delete! = |client, session| {
		response = client.send_authed!(Events.delete_request(client.site, session.queue_id))?
		match Api.decode_error(response.body) {
			Ok(err_body) => Err(ApiError(err_body))
			Err(NotAnApiError) => {
				# not an error payload — but only a real success payload is
				# success; anything else (e.g. a proxy's HTML 502) is not
				probe : Try({ result : Str }, _)
				probe = Json.parse(response.body)
				match probe {
					Ok(p) => if p.result == "success" Ok({}) else Err(BadResponse(response.body))
					Err(_) => Err(BadResponse(response.body))
				}
			}
		}
	}

	## Advance the event cursor past every event in the batch.
	next_cursor : I64, List(Events.EventMeta) -> I64
	next_cursor = |current, events|
		events.fold(current, |acc, ev| if ev.id > acc ev.id else acc)

	## Lift BAD_EVENT_QUEUE_ID out of the generic API-error bucket, since it's
	## the one error a polling loop must react to (by re-registering).
	classify_poll_error : [ApiError(Api.ErrorBody), BadResponse(Str)] -> [QueueInvalid(Str), ApiError(Api.ErrorBody), BadResponse(Str), ..]
	classify_poll_error = |err|
		match err {
			ApiError({ code, msg }) => {
				if code == "BAD_EVENT_QUEUE_ID" {
					QueueInvalid(msg)
				} else {
					ApiError({ code, msg })
				}
			}
			BadResponse(body) => BadResponse(body)
		}
}

# --- tests (pure helpers) ---

expect Session.next_cursor(4, [{ id: 5, type: "message" }, { id: 6, type: "heartbeat" }]) == 6
expect Session.next_cursor(4, []) == 4
# ids never move backwards, even if the server replays an old event
expect Session.next_cursor(9, [{ id: 5, type: "message" }]) == 9

expect
	Session.classify_poll_error(ApiError({ code: "BAD_EVENT_QUEUE_ID", msg: "Bad event queue ID: q:old" }))
		== QueueInvalid("Bad event queue ID: q:old")

expect
	Session.classify_poll_error(ApiError({ code: "RATE_LIMIT_HIT", msg: "slow down" }))
		== ApiError({ code: "RATE_LIMIT_HIT", msg: "slow down" })

expect Session.classify_poll_error(BadResponse("<html>502</html>")) == BadResponse("<html>502</html>")
