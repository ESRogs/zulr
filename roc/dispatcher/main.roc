## zulr dispatcher (Roc): watches Zulip for messages directed at stopped mngr
## agents and wakes them via `mngr start`.
##
## One Zulip event-queue session per managed bot (each bot's API key from the
## zulr state DB). The platform has no concurrency primitives, so this is a
## single loop: every sweep it short-polls each session (dont_block=true),
## evaluates message events for wake-worthiness (DM / @-mention / followed
## topic), sleeps, repeats. Agent statuses refresh every status_every sweeps;
## sessions re-register every reregister_every sweeps to refresh the
## followed-topics snapshot.
##
## Env: ZULIP_SITE (required); ZULR_STATE_DB (path to state.db), or
## ZULR_REPO_ROOT + HOME to derive ~/.zulr/<slug>/state.db.

app [main!] {
	pf: platform "../../../../roc/basic-cli/platform/main.roc",
	zulip: "../zulip-roc/main.roc",
	http: "https://github.com/roc-lang/http/releases/download/1.0.0/6ZUwqYhCS8PU9Mo6MF7oV82ET2o7KYb57CLKDq4cq4sS.tar.zst",
}

import pf.OsStr exposing [OsStr]
import pf.Stdout
import pf.Stderr
import pf.Env
import pf.Sqlite
import pf.Path
import pf.Cmd
import pf.Sleep
import pf.Utc
import pf.Http
import http.Request
import http.Response
import zulip.Client
import zulip.Session
import zulip.Events
import zulip.Notify

sweep_ms : U64
sweep_ms = 3000

status_every : U64
status_every = 10 # sweeps -> 30s at sweep_ms=3000

reregister_every : U64
reregister_every = 100 # sweeps -> 5min at sweep_ms=3000

wake_cooldown_ms : U128
wake_cooldown_ms = 60_000

## Queue registration policy: stream message events from all public streams,
## and fetch the followed-topics snapshot for wake evaluation.
register_opts : Events.RegisterOptions
register_opts = {
	event_types: ["message"],
	fetch_event_types: ["user_topic"],
	all_public_streams: Bool.True,
}

Teammate : { name : Str, bot_email : Str, api_key : Str }

AgentStatus : { name : Str, running : Bool }

Cooldown : { name : Str, until_ms : U128 }

BotWatch : { name : Str, client : Client.Client, session : Session.Session }

DispatchState : {
	site : Str,
	bots : List(BotWatch),
	unregistered : List(Teammate),
	statuses : List(AgentStatus),
	cooldowns : List(Cooldown),
	sweep : U64,
}

main! : List(OsStr) => Try({}, _)
main! = |_args| {
	site = env_str!("ZULIP_SITE")?
	db_path = state_db_path!()?

	teammates = read_teammates!(db_path) ? |err| ReadTeammatesFailed(err)
	if teammates.is_empty() {
		Stderr.line!("no teammates registered — nothing to watch")?
		return Err(Exit(1))
	}

	log!("zulr dispatcher (roc) starting — ${U64.to_str(teammates.len())} bot(s) on ${site}")

	inited = init_bots!(site, teammates, { bots: [], unregistered: [] })
	if inited.bots.is_empty() {
		log!("no session registered yet — will keep retrying")
	}

	# A failing mngr must not kill the dispatcher — statuses just refresh later.
	statuses = match mngr_statuses!() {
		Ok(fresh) => fresh
		Err(err) => {
			log!("initial mngr list failed: ${Str.inspect(err)}")
			[]
		}
	}
	log!("initial agent statuses: ${statuses_str(statuses)}")
	log!("dispatcher running — watching ${U64.to_str(inited.bots.len())} bot(s)")

	sweep_loop!({
		site,
		bots: inited.bots,
		unregistered: inited.unregistered,
		statuses,
		cooldowns: [],
		sweep: 1,
	})
	Ok({})
}

# --- main loop ---

sweep_loop! : DispatchState => {}
sweep_loop! = |state| {
	statuses = 
		if state.sweep % status_every == 0 {
			match mngr_statuses!() {
				Ok(fresh) => fresh
				Err(err) => {
					log!("mngr list failed: ${Str.inspect(err)}")
					state.statuses
				}
			}
		} else {
			state.statuses
		}

	# retry teammates whose registration failed (e.g. a startup network blip)
	recovered = 
		if state.sweep % status_every == 0 and !state.unregistered.is_empty() {
			init_bots!(state.site, state.unregistered, { bots: state.bots, unregistered: [] })
		} else {
			{ bots: state.bots, unregistered: state.unregistered }
		}

	reregister = state.sweep % reregister_every == 0
	swept = sweep_bots!(recovered.bots, reregister, statuses, [], [])
	now_ms = Utc.to_millis_since_epoch(Utc.now!())
	live_cooldowns = state.cooldowns.keep_if(|c| c.until_ms > now_ms)
	woken = process_wakes!(swept.wakes, statuses, live_cooldowns, now_ms)

	Sleep.millis!(sweep_ms)
	sweep_loop!({
		site: state.site,
		bots: swept.bots,
		unregistered: recovered.unregistered,
		statuses: woken.statuses,
		cooldowns: woken.cooldowns,
		sweep: state.sweep + 1,
	})
}

## Poll every bot's session once; collect updated sessions and wake requests.
## On a scheduled re-register sweep, each bot is polled first so the old
## queue's tail is consumed before the queue is replaced. Message fetches are
## skipped for agents that aren't stopped: process_wakes! gates on the same
## statuses value, so the result would be discarded anyway — the poll still
## happens, to advance the queue cursor.
sweep_bots! : List(BotWatch), Bool, List(AgentStatus), List(BotWatch), List({ name : Str, reason : Str }) => { bots : List(BotWatch), wakes : List({ name : Str, reason : Str }) }
sweep_bots! = |pending, reregister, statuses, done, wakes|
	match pending {
		[] => { bots: done, wakes }
		[bot, .. as rest] => {
			polled = poll_bot!(bot, is_stopped(statuses, bot.name))
			refreshed = 
				if reregister and !polled.just_registered {
					refresh_session!(polled.bot, DeleteOld)
				} else {
					polled.bot
				}
			new_wakes = match polled.reason {
				Wake(reason) => wakes.append({ name: bot.name, reason })
				NoWake => wakes
			}
			sweep_bots!(rest, reregister, statuses, done.append(refreshed), new_wakes)
		}
	}

## Replace a bot's session with a freshly registered queue (which also
## refreshes the followed-topics snapshot); on failure the old session is
## kept (logged). DeleteOld removes the replaced queue server-side; pass
## OldGone when the old queue is already dead.
refresh_session! : BotWatch, [DeleteOld, OldGone] => BotWatch
refresh_session! = |bot, cleanup|
	match Session.register!(bot.client, register_opts) {
		Ok(new_session) => {
			if cleanup == DeleteOld {
				# best effort — an undeleted queue expires on its own
				match Session.delete!(bot.client, bot.session) {
					Ok({}) => {}
					Err(err) => log!("[${bot.name}] old queue delete failed: ${Str.inspect(err)}")
				}
			}
			{ ..bot, session: new_session }
		}
		Err(err) => {
			log!("[${bot.name}] re-register failed: ${Str.inspect(err)}")
			bot
		}
	}

## One bot's poll: fetch new events and, when the agent is stopped (so a wake
## could matter), evaluate them for the first wake-worthy reason. Poll errors
## are logged, never fatal; an invalid queue is re-registered on the spot
## (reported via just_registered, so a scheduled re-register on the same
## sweep doesn't replace the queue a second time).
poll_bot! : BotWatch, Bool => { bot : BotWatch, reason : [Wake(Str), NoWake], just_registered : Bool }
poll_bot! = |bot, agent_stopped|
	match Session.poll!(bot.client, bot.session) {
		Ok((session, polled)) => {
			if polled.lossy {
				types = Str.join_with(polled.events.map(|ev| ev.type), ", ")
				log!("[${bot.name}] mixed event batch (${types}) — could not extract message ids (batch skipped)")
			}
			reason = 
				if agent_stopped {
					evaluate_messages!(bot, polled.message_ids, NoWake)
				} else {
					NoWake
				}
			{ bot: { ..bot, session }, reason, just_registered: Bool.False }
		}
		Err(QueueInvalid(_)) => {
			log!("[${bot.name}] event queue expired; re-registering")
			{ bot: refresh_session!(bot, OldGone), reason: NoWake, just_registered: Bool.True }
		}
		Err(err) => {
			log!("[${bot.name}] poll failed: ${Str.inspect(err)}")
			{ bot, reason: NoWake, just_registered: Bool.False }
		}
	}

## Fetch each new message by id and evaluate it for wake-worthiness.
## The first wake-worthy reason wins (one wake per bot per sweep is enough).
evaluate_messages! : BotWatch, List(I64), [Wake(Str), NoWake] => [Wake(Str), NoWake]
evaluate_messages! = |bot, message_ids, found|
	match message_ids {
		[] => found
		[message_id, .. as rest] => {
			match found {
				Wake(_) => found
				NoWake => {
					next = match bot.client.get_message!(message_id) {
						Ok(message) => {
							match Notify.evaluate(message, bot.session.user_topics) {
								Silent => NoWake
								reason => Wake(reason_str(reason))
							}
						}
						Err(err) => {
							log!("[${bot.name}] get_message ${I64.to_str(message_id)} failed: ${Str.inspect(err)}")
							NoWake
						}
					}
					evaluate_messages!(bot, rest, next)
				}
			}
		}
	}

## Wake each requested agent if it's known-stopped and not on cooldown.
process_wakes! : List({ name : Str, reason : Str }), List(AgentStatus), List(Cooldown), U128 => { statuses : List(AgentStatus), cooldowns : List(Cooldown) }
process_wakes! = |wakes, statuses, cooldowns, now_ms|
	match wakes {
		[] => { statuses, cooldowns }
		[wake, .. as rest] => {
			if !is_stopped(statuses, wake.name) {
				process_wakes!(rest, statuses, cooldowns, now_ms)
			} else if on_cooldown(cooldowns, wake.name, now_ms) {
				log!("skipping wake for '${wake.name}' (cooldown)")
				process_wakes!(rest, statuses, cooldowns, now_ms)
			} else {
				log!("waking agent '${wake.name}' — ${wake.reason}")
				match wake_agent!(wake.name) {
					Ok({}) => {
						log!("agent '${wake.name}' started successfully")
						process_wakes!(
							rest,
							set_running(statuses, wake.name),
							cooldowns.append({ name: wake.name, until_ms: now_ms + wake_cooldown_ms }),
							now_ms,
						)
					}
					Err(err) => {
						log!("failed to start '${wake.name}': ${Str.inspect(err)}")
						process_wakes!(rest, statuses, cooldowns, now_ms)
					}
				}
			}
		}
	}

# --- pure helpers ---

## Only a known-stopped agent is woken; unknown agents are left alone.
is_stopped : List(AgentStatus), Str -> Bool
is_stopped = |statuses, name|
	statuses.any(|s| s.name == name and !s.running)

on_cooldown : List(Cooldown), Str, U128 -> Bool
on_cooldown = |cooldowns, name, now_ms|
	cooldowns.any(|c| c.name == name and c.until_ms > now_ms)

set_running : List(AgentStatus), Str -> List(AgentStatus)
set_running = |statuses, name|
	statuses.map(|s| if s.name == name { ..s, running: Bool.True } else s)

reason_str : Notify.Reason -> Str
reason_str = |reason|
	match reason {
		Dm => "dm"
		Mentioned => "mentioned"
		WildcardMentioned => "wildcard_mentioned"
		FollowedTopic => "followed_topic"
		Silent => "silent"
	}

## mngr reports RUNNING / WAITING / STOPPED ("running" is also seen lowercase
## from older versions).
state_is_running : Str -> Bool
state_is_running = |state|
	state == "RUNNING" or state == "WAITING" or state == "running"

statuses_str : List(AgentStatus) -> Str
statuses_str = |statuses|
	Str.join_with(
		statuses.map(|s| "${s.name}=${if s.running "running" else "stopped"}"),
		", ",
	)

## Derive the state-DB directory slug the same way state/db.ts does:
## the absolute repo path with every '/' replaced by '-'.
repo_slug : Str -> Str
repo_slug = |repo_root|
	Str.from_utf8_lossy(Str.to_utf8(repo_root).map(|b| if b == 47 45 else b))

## db.ts resolves the repo root before slugging; instead of porting path
## normalization, trailing slashes are trimmed and anything else non-absolute
## is rejected — a silently different slug would open a nonexistent DB.
normalize_repo_root : Str -> Try(Str, [RepoRootNotAbsolute(Str), ..])
normalize_repo_root = |raw| {
	trimmed = trim_trailing_slashes(raw)
	if trimmed.starts_with("/") {
		Ok(trimmed)
	} else {
		Err(RepoRootNotAbsolute(raw))
	}
}

trim_trailing_slashes : Str -> Str
trim_trailing_slashes = |s|
	if s != "/" and s.ends_with("/") {
		trim_trailing_slashes(s.drop_suffix("/"))
	} else {
		s
	}

# --- effectful setup + adapters ---

## Register a session per teammate. Failures are logged and collected in
## `unregistered` so the sweep loop keeps retrying them — a transient error
## at startup must not lose a teammate for the process lifetime.
init_bots! : Str, List(Teammate), { bots : List(BotWatch), unregistered : List(Teammate) } => { bots : List(BotWatch), unregistered : List(Teammate) }
init_bots! = |site, pending, done|
	match pending {
		[] => done
		[teammate, .. as rest] => {
			client = Client.new(
				{ site, email: teammate.bot_email, api_key: teammate.api_key },
				http_send!,
			)
			match Session.register!(client, register_opts) {
				Ok(session) => {
					log!("[${teammate.name}] session registered (queue ${session.queue_id})")
					init_bots!(site, rest, { ..done, bots: done.bots.append({ name: teammate.name, client, session }) })
				}
				Err(err) => {
					log!("[${teammate.name}] session registration failed: ${Str.inspect(err)}")
					init_bots!(site, rest, { ..done, unregistered: done.unregistered.append(teammate) })
				}
			}
		}
	}

## The platform transport, adapted to the Client's send! shape.
http_send! : Request.Request => Try(Response.Response, Str)
http_send! = |req|
	Http.send!(req).map_err(|err| Str.inspect(err))

mngr_statuses! : () => Try(List(AgentStatus), [MngrFailed(Str), MngrOutputUndecodable(Str), ..])
mngr_statuses! = || {
	out = Cmd.new("mngr").args(["list", "--format", "json"]).exec_output!()
		? |err| MngrFailed(Str.inspect(err))
	# mngr emits {"agents": [{name, state}, ...]}; a bare array is tolerated
	# too. (The TS dispatcher also accepted agent_name/status field aliases —
	# that defensiveness is dropped deliberately.)
	wrapped : Try({ agents : List({ name : Str, state : Str }) }, _)
	wrapped = Json.parse(out.stdout_utf8)
	match wrapped {
		Ok({ agents }) => Ok(agents.map(to_status))
		Err(_) => {
			bare : Try(List({ name : Str, state : Str }), _)
			bare = Json.parse(out.stdout_utf8)
			match bare {
				Ok(agents) => Ok(agents.map(to_status))
				Err(_) => Err(MngrOutputUndecodable(out.stdout_utf8))
			}
		}
	}
}

to_status : { name : Str, state : Str } -> AgentStatus
to_status = |agent| { name: agent.name, running: state_is_running(agent.state) }

wake_agent! : Str => Try({}, [WakeFailed(Str), ..])
wake_agent! = |name| {
	_out = Cmd.new("mngr").args(["start", "--", OsStr.from_str(name)]).exec_output!()
		? |err| WakeFailed(Str.inspect(err))
	Ok({})
}

read_teammates! : Str => Try(List(Teammate), _)
read_teammates! = |db_path|
	Sqlite.query_many!({
		path: Path.from_str(db_path),
		query: "SELECT name, bot_email, api_key FROM teammates ORDER BY name;",
		bindings: [],
		rows: decode_teammate,
	})

decode_teammate = |cols|
	|stmt| {
		name = Sqlite.str("name")(cols)(stmt)?
		bot_email = Sqlite.str("bot_email")(cols)(stmt)?
		api_key = Sqlite.str("api_key")(cols)(stmt)?
		Ok({ name, bot_email, api_key })
	}

state_db_path! : () => Try(Str, [MissingEnv(Str), RepoRootNotAbsolute(Str), ..])
state_db_path! = ||
	match env_str!("ZULR_STATE_DB") {
		Ok(path) => Ok(path)
		Err(_) => {
			repo_root = env_str!("ZULR_REPO_ROOT")
				? |_| MissingEnv("set ZULR_STATE_DB or ZULR_REPO_ROOT")
			normalized = normalize_repo_root(repo_root)?
			home = env_str!("HOME") ? |_| MissingEnv("HOME is not set")
			Ok("${home}/.zulr/${repo_slug(normalized)}/state.db")
		}
	}

env_str! : Str => Try(Str, [EnvVarMissing(Str), EnvVarInvalid(Str), ..])
env_str! = |name| {
	os_val = Env.var!(OsStr.from_str(name)) ? |_| EnvVarMissing(name)
	str_val = OsStr.to_str_try(os_val) ? |_| EnvVarInvalid(name)
	Ok(str_val)
}

## Best-effort: a failed stdout write (closed pipe, rotated log) must not
## kill the long-running dispatcher, so write errors are deliberately dropped.
log! : Str => {}
log! = |msg|
	match Stdout.line!("[dispatcher] ${msg}") {
		Ok({}) => {}
		Err(_) => {}
	}

# --- tests for the pure helpers ---

expect is_stopped([{ name: "coder", running: Bool.False }], "coder")
expect !is_stopped([{ name: "coder", running: Bool.True }], "coder")
# unknown agents are not woken
expect !is_stopped([], "ghost")

expect on_cooldown([{ name: "coder", until_ms: 100 }], "coder", 99)
expect !on_cooldown([{ name: "coder", until_ms: 100 }], "coder", 100)
expect !on_cooldown([], "coder", 0)

expect
	set_running([{ name: "a", running: Bool.False }, { name: "b", running: Bool.False }], "a")
		== [{ name: "a", running: Bool.True }, { name: "b", running: Bool.False }]

expect state_is_running("RUNNING")
expect state_is_running("WAITING")
expect !state_is_running("STOPPED")

expect repo_slug("/Users/rogs/code/ESRogs/zulr") == "-Users-rogs-code-ESRogs-zulr"

expect normalize_repo_root("/a/b/") == Ok("/a/b")
expect normalize_repo_root("/a//") == Ok("/a")
expect normalize_repo_root("/") == Ok("/")
expect normalize_repo_root("relative/path") == Err(RepoRootNotAbsolute("relative/path"))
expect normalize_repo_root("") == Err(RepoRootNotAbsolute(""))

expect reason_str(Dm) == "dm"
expect reason_str(FollowedTopic) == "followed_topic"
