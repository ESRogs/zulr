## zulr event listener (Roc): delivers Zulip activity to Claude Code teammate
## inbox files (~/.claude/teams/<team>/inboxes/<name>.json).
##
## One event-queue session per managed bot (API keys from the zulr state DB),
## short-polled in a single loop (the platform has no concurrency primitives).
## Per message event: the bot's own messages are skipped; DMs from other bots
## are blocked; DMs and notification-worthy stream messages (mention or
## followed topic — the same policy the dispatcher uses, via zulip.Notify)
## are appended to the bot's inbox and marked read on Zulip. A mention also
## auto-follows the topic (unless it is resolved, prefix "✔ "). Reactions to
## a bot's own message are delivered as a preview line. When a topic is
## renamed to resolved, its follow is dropped after a grace period (cancelled
## if the topic is un-resolved in the meantime).
##
## Queue expiry re-registers on the spot; events between expiry and re-
## registration are lost and logged (the TS listener backfills here — a
## known gap of this port, tracked in roc/README.md).
##
## Env: ZULIP_SITE (required); ZULR_TEAM (inbox team name, default
## "default"); HOME; ZULR_STATE_DB, or ZULR_REPO_ROOT to derive it.

app [main!] {
	pf: platform "https://github.com/roc-lang/basic-cli/releases/download/0.21.0-rc4/FvCh4vdqm3nBY6DWEfZ8RuGCVfjuMY43HA8KSNk9qVDn.tar.zst",
	zulip: "../zulip-roc/main.roc",
	http: "https://github.com/roc-lang/http/releases/download/1.0.0/6ZUwqYhCS8PU9Mo6MF7oV82ET2o7KYb57CLKDq4cq4sS.tar.zst",
}

import pf.OsStr exposing [OsStr]
import pf.Stdout
import pf.Stderr
import pf.Env
import pf.Sqlite
import pf.Path
import pf.Sleep
import pf.Utc
import pf.Http
import http.Request
import http.Response
import zulip.Client
import zulip.Session
import zulip.Events
import zulip.Channels
import zulip.Users
import zulip.Messages
import zulip.Notify
import Inbox

sweep_ms : U64
sweep_ms = 3000

retry_every : U64
retry_every = 10 # sweeps -> 30s at sweep_ms=3000

reregister_every : U64
reregister_every = 100 # sweeps -> 5min at sweep_ms=3000 (refreshes followed topics)

unfollow_delay_ms : U128
unfollow_delay_ms = 60_000

resolved_prefix : Str
resolved_prefix = "✔ "

summary_max_bytes : U64
summary_max_bytes = 60

preview_max_bytes : U64
preview_max_bytes = 40

## Queue registration policy: message events plus the reaction and topic-
## rename events the listener reacts to, from all public streams, with the
## followed-topics snapshot fetched for notification decisions.
register_opts : Events.RegisterOptions
register_opts = {
	event_types: ["message", "update_message", "reaction"],
	fetch_event_types: ["user_topic"],
	all_public_streams: Bool.True,
}

Teammate : { name : Str, bot_email : Str, api_key : Str }

PendingUnfollow : { stream_id : I64, topic : Str, due_ms : U128 }

BotWatch : {
	name : Str,
	email : Str,
	client : Client.Client,
	session : Session.Session,
	unfollows : List(PendingUnfollow),
}

## Where inbox entries get written.
InboxTarget : { home : Str, team : Str }

ListenState : {
	site : Str,
	target : InboxTarget,
	bot_emails : List(Str),
	bots : List(BotWatch),
	unregistered : List(Teammate),
	channels : List(Channels.Channel),
	members : List(Users.Member),
	sweep : U64,
}

main! : List(OsStr) => Try({}, _)
main! = |_args| {
	site = env_str!("ZULIP_SITE")?
	team = match env_str!("ZULR_TEAM") {
		Ok(t) => t
		Err(_) => "default"
	}
	home = env_str!("HOME")?
	db_path = state_db_path!()?

	teammates = read_teammates!(db_path) ? |err| ReadTeammatesFailed(err)
	if teammates.is_empty() {
		Stderr.line!("no teammates registered — nothing to listen for")?
		return Err(Exit(1))
	}

	log!("zulr event listener (roc) starting — ${U64.to_str(teammates.len())} bot(s) on ${site}, team '${team}'")

	inited = init_bots!(site, teammates, { bots: [], unregistered: [] })
	if inited.bots.is_empty() {
		log!("no session registered yet — will keep retrying")
	}

	# Channel and member caches for stream-name and reactor-name resolution;
	# a failed initial fetch just means resolution refreshes on first miss.
	channels = fetch_channels!(inited.bots)
	members = fetch_members!(inited.bots)

	log!("listening — ${U64.to_str(inited.bots.len())} session(s), ${U64.to_str(channels.len())} channel(s) cached")

	sweep_loop!({
		site,
		target: { home, team },
		bot_emails: teammates.map(|t| t.bot_email),
		bots: inited.bots,
		unregistered: inited.unregistered,
		channels,
		members,
		sweep: 1,
	})
	Ok({})
}

# --- main loop ---

sweep_loop! : ListenState => {}
sweep_loop! = |state| {
	# retry teammates whose registration failed (e.g. a startup network blip)
	recovered = 
		if state.sweep % retry_every == 0 and !state.unregistered.is_empty() {
			init_bots!(state.site, state.unregistered, { bots: state.bots, unregistered: [] })
		} else {
			{ bots: state.bots, unregistered: state.unregistered }
		}

	reregister = state.sweep % reregister_every == 0
	now_ms = Utc.to_millis_since_epoch(Utc.now!())
	swept = sweep_bots!(recovered.bots, state, reregister, now_ms, [])

	Sleep.millis!(sweep_ms)
	sweep_loop!({
		..state,
		bots: swept.bots,
		unregistered: recovered.unregistered,
		channels: swept.channels,
		members: swept.members,
		sweep: state.sweep + 1,
	})
}

## Poll every bot once, handle its events, and run its due unfollows. The
## channel/member caches thread through because any bot's sweep may refresh
## them. On a scheduled re-register sweep each bot is polled first, so the
## old queue's tail is consumed before the queue is replaced.
sweep_bots! : List(BotWatch), ListenState, Bool, U128, List(BotWatch) => { bots : List(BotWatch), channels : List(Channels.Channel), members : List(Users.Member) }
sweep_bots! = |pending, state, reregister, now_ms, done|
	match pending {
		[] => { bots: done, channels: state.channels, members: state.members }
		[bot, .. as rest] => {
			polled = poll_bot!(bot, state, now_ms)
			refreshed = 
				if reregister and !polled.just_registered {
					refresh_session!(polled.bot, DeleteOld)
				} else {
					polled.bot
				}
			settled = run_due_unfollows!(refreshed, now_ms)
			next_state = { ..state, channels: polled.channels, members: polled.members }
			sweep_bots!(rest, next_state, reregister, now_ms, done.append(settled))
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

## One bot's poll: decode the batch and handle each event.
poll_bot! : BotWatch, ListenState, U128 => { bot : BotWatch, channels : List(Channels.Channel), members : List(Users.Member), just_registered : Bool }
poll_bot! = |bot, state, now_ms|
	match Session.poll_inbound!(bot.client, bot.session) {
		Ok((session, polled)) => {
			handled = handle_events!(polled.inbound, { ..bot, session }, state, now_ms)
			{ bot: handled.bot, channels: handled.channels, members: handled.members, just_registered: Bool.False }
		}
		Err(QueueInvalid(_)) => {
			log!("[${bot.name}] event queue expired; re-registering (events in the gap are lost — no backfill yet)")
			{ bot: refresh_session!(bot, OldGone), channels: state.channels, members: state.members, just_registered: Bool.True }
		}
		Err(err) => {
			log!("[${bot.name}] poll failed: ${Str.inspect(err)}")
			{ bot, channels: state.channels, members: state.members, just_registered: Bool.False }
		}
	}

## Handle a batch of inbound events for one bot, threading the caches (a
## stream-name or member miss refreshes them) and the bot itself (mention
## auto-follow updates its followed-topics snapshot; topic renames update
## its pending unfollows).
handle_events! : List(Events.InboundEvent), BotWatch, ListenState, U128 => { bot : BotWatch, channels : List(Channels.Channel), members : List(Users.Member) }
handle_events! = |events, bot, state, now_ms|
	match events {
		[] => { bot, channels: state.channels, members: state.members }
		[event, .. as rest] => {
			result = handle_event!(event, bot, state, now_ms)
			next_state = { ..state, channels: result.channels, members: result.members }
			handle_events!(rest, result.bot, next_state, now_ms)
		}
	}

handle_event! : Events.InboundEvent, BotWatch, ListenState, U128 => { bot : BotWatch, channels : List(Channels.Channel), members : List(Users.Member) }
handle_event! = |event, bot, state, now_ms|
	match event {
		MessageEvent({ flags, message }) => handle_message!(flags, message, bot, state)
		ReactionAdd(reaction) => {
			members = handle_reaction!(reaction, bot, state)
			{ bot, channels: state.channels, members }
		}
		TopicMoved(moved) => {
			{ bot: handle_topic_moved(moved, bot, now_ms), channels: state.channels, members: state.members }
		}
		Other(_) => { bot, channels: state.channels, members: state.members }
	}

# --- message delivery ---

handle_message! : List(Str), Events.InboundMessage, BotWatch, ListenState => { bot : BotWatch, channels : List(Channels.Channel), members : List(Users.Member) }
handle_message! = |flags, message, bot, state| {
	unchanged = { bot, channels: state.channels, members: state.members }
	if message.sender_email == bot.email {
		unchanged
	} else if message.type == "private" {
		# block bot-to-bot DMs
		if state.bot_emails.contains(message.sender_email) {
			unchanged
		} else {
			deliver_dm!(message, bot, state.target)
			unchanged
		}
	} else {
		match (message.stream_id, message.subject) {
			(Ok(stream_id), Ok(topic)) => {
				reason = Notify.evaluate(
					Stream({ id: message.id, sender_id: message.sender_id, flags, stream_id, topic }),
					bot.session.user_topics,
				)
				if reason == Silent {
					unchanged
				} else {
					resolved = resolve_stream_name!(state.channels, stream_id, bot.client)
					deliver_stream!(message, stream_id, topic, resolved.name, bot, state.target)
					followed_bot = follow_on_mention!(reason, stream_id, topic, bot)
					{ bot: followed_bot, channels: resolved.channels, members: state.members }
				}
			}
			_ => {
				log!("[${bot.name}] stream message ${I64.to_str(message.id)} missing stream fields — skipped")
				unchanged
			}
		}
	}
}

deliver_dm! : Events.InboundMessage, BotWatch, InboxTarget => {}
deliver_dm! = |message, bot, target| {
	entry = {
		from: "zulip:${message.sender_full_name}",
		text: "${message.content}\n${Inbox.format_footer(message.id, epoch_secs_iso(message.timestamp))}",
		summary: Inbox.sanitize_summary(Inbox.truncate(message.content, summary_max_bytes)),
		timestamp_iso: now_iso!(),
		zulip_message_id: message.id,
		zulip_sender_id: message.sender_id,
		context: InDm,
		zulip_sender: message.sender_full_name,
	}
	deliver_and_mark_read!(entry, message.id, bot, target)
}

deliver_stream! : Events.InboundMessage, I64, Str, Str, BotWatch, InboxTarget => {}
deliver_stream! = |message, _stream_id, topic, stream_name, bot, target| {
	entry = {
		from: "zulip:${stream_name}/${topic}:${message.sender_full_name}",
		text: "${message.content}\n${Inbox.format_footer(message.id, epoch_secs_iso(message.timestamp))}",
		summary: Inbox.sanitize_summary(Inbox.truncate(message.content, summary_max_bytes)),
		timestamp_iso: now_iso!(),
		zulip_message_id: message.id,
		zulip_sender_id: message.sender_id,
		context: InStream({ stream: stream_name, topic }),
		zulip_sender: message.sender_full_name,
	}
	deliver_and_mark_read!(entry, message.id, bot, target)
}

## Write the entry, then mark the message read on Zulip. Marking read only
## happens after a successful write (the TS listener marks read regardless;
## keeping the message unread on write failure means catch-up can still
## find it).
deliver_and_mark_read! : Inbox.Entry, I64, BotWatch, InboxTarget => {}
deliver_and_mark_read! = |entry, message_id, bot, target|
	match write_inbox!(target, bot.name, entry) {
		Ok(Written) => {
			log!("[${bot.name}] delivered ${entry.from} (msg ${I64.to_str(message_id)})")
			match bot.client.mark_read!([message_id]) {
				Ok({}) => {}
				Err(err) => log!("[${bot.name}] mark-read failed for ${I64.to_str(message_id)}: ${Str.inspect(err)}")
			}
		}
		Ok(Duplicate) => {}
		Err(err) => log!("[${bot.name}] inbox write failed: ${Str.inspect(err)}")
	}

## Follow the topic when the bot was mentioned, unless the topic is resolved.
## A successful follow is reflected in the local followed-topics snapshot so
## later messages in this topic notify without waiting for a re-register.
follow_on_mention! : Notify.Reason, I64, Str, BotWatch => BotWatch
follow_on_mention! = |reason, stream_id, topic, bot| {
	is_mention = reason == Mentioned or reason == WildcardMentioned
	if is_mention and !topic.starts_with(resolved_prefix) {
		match bot.client.set_topic_visibility!({ stream_id, topic, visibility_policy: Events.followed_policy }) {
			Ok({}) => {
				log!("[${bot.name}] followed topic ${topic}")
				already = bot.session.user_topics.any(|t| t.stream_id == stream_id and t.topic_name == topic)
				if already {
					bot
				} else {
					topics = bot.session.user_topics.append({ stream_id, topic_name: topic, visibility_policy: Events.followed_policy })
					{ ..bot, session: { ..bot.session, user_topics: topics } }
				}
			}
			Err(err) => {
				log!("[${bot.name}] follow failed for ${topic}: ${Str.inspect(err)}")
				bot
			}
		}
	} else {
		bot
	}
}

# --- reactions ---

## Deliver a reaction to the bot that authored the reacted-to message. The
## message is fetched by id (content preview + authorship); the reactor's
## name resolves from the member cache.
handle_reaction! : { message_id : I64, user_id : I64, emoji_name : Str }, BotWatch, ListenState => List(Users.Member)
handle_reaction! = |reaction, bot, state|
	match bot.client.get_full_message!(reaction.message_id) {
		Ok(full) => {
			authored = match full {
				StreamMessage(m) => m.sender_email == bot.email
				DmMessage(m) => m.sender_email == bot.email
			}
			if !authored {
				state.members
			} else {
				resolved = resolve_member_name!(state.members, reaction.user_id, bot.client)
				preview = Inbox.sanitize_summary(Inbox.truncate(content_of(full), preview_max_bytes))
				summary = ":${reaction.emoji_name}: on \u(201C)${preview}\u(201D)"
				entry = {
					from: reaction_from(full, resolved.name),
					text: "${summary}\n[msg:${I64.to_str(reaction.message_id)}]",
					summary,
					timestamp_iso: now_iso!(),
					# NOTE: dedupe is by zulipMessageId, so a second reaction on
					# the same message is skipped (TS behavior, ported as-is)
					zulip_message_id: reaction.message_id,
					zulip_sender_id: reaction.user_id,
					context: reaction_context(full),
					zulip_sender: resolved.name,
				}
				match write_inbox!(state.target, bot.name, entry) {
					Ok(Written) => log!("[${bot.name}] delivered reaction :${reaction.emoji_name}: on msg ${I64.to_str(reaction.message_id)}")
					Ok(Duplicate) => {}
					Err(err) => log!("[${bot.name}] reaction inbox write failed: ${Str.inspect(err)}")
				}
				resolved.members
			}
		}
		Err(err) => {
			log!("[${bot.name}] reaction lookup failed for msg ${I64.to_str(reaction.message_id)}: ${Str.inspect(err)}")
			state.members
		}
	}

content_of : Messages.FullMessage -> Str
content_of = |full|
	match full {
		StreamMessage(m) => m.content
		DmMessage(m) => m.content
	}

reaction_from : Messages.FullMessage, Str -> Str
reaction_from = |full, reactor|
	match full {
		StreamMessage(m) => "zulip:${m.stream}/${m.topic}:${reactor}"
		DmMessage(_) => "zulip:${reactor}"
	}

reaction_context : Messages.FullMessage -> [InStream({ stream : Str, topic : Str }), InDm]
reaction_context = |full|
	match full {
		StreamMessage(m) => InStream({ stream: m.stream, topic: m.topic })
		DmMessage(_) => InDm
	}

# --- resolved-topic auto-unfollow ---

## When a followed topic is renamed to resolved, schedule an unfollow after
## a grace period; un-resolving in the meantime cancels it. Pure: the due
## work runs in run_due_unfollows!.
handle_topic_moved : { stream_id : I64, subject : Str, orig_subject : Try(Str, [Missing]) }, BotWatch, U128 -> BotWatch
handle_topic_moved = |moved, bot, now_ms| {
	orig = moved.orig_subject.ok_or(moved.subject)
	# the local snapshot may still hold the pre-rename name (Zulip emits no
	# user_topic event on rename), so check both
	was_followed = 
		is_followed(bot.session.user_topics, moved.stream_id, orig)
			or is_followed(bot.session.user_topics, moved.stream_id, moved.subject)

	if moved.subject.starts_with(resolved_prefix) and was_followed {
		kept = bot.unfollows.keep_if(|u| !(u.stream_id == moved.stream_id and topic_eq(u.topic, moved.subject)))
		scheduled = kept.append({ stream_id: moved.stream_id, topic: moved.subject, due_ms: now_ms + unfollow_delay_ms })
		{ ..bot, unfollows: scheduled }
	} else if orig.starts_with(resolved_prefix) and !moved.subject.starts_with(resolved_prefix) {
		kept = bot.unfollows.keep_if(|u| !(u.stream_id == moved.stream_id and topic_eq(u.topic, orig)))
		{ ..bot, unfollows: kept }
	} else {
		bot
	}
}

run_due_unfollows! : BotWatch, U128 => BotWatch
run_due_unfollows! = |bot, now_ms| {
	due = bot.unfollows.keep_if(|u| u.due_ms <= now_ms)
	remaining = bot.unfollows.keep_if(|u| u.due_ms > now_ms)
	unfollow_each!(due, { ..bot, unfollows: remaining })
}

unfollow_each! : List(PendingUnfollow), BotWatch => BotWatch
unfollow_each! = |pending, bot|
	match pending {
		[] => bot
		[unfollow, .. as rest] => {
			updated = 
				match bot.client.set_topic_visibility!({ stream_id: unfollow.stream_id, topic: unfollow.topic, visibility_policy: Events.inherit_policy }) {
					Ok({}) => {
						log!("[${bot.name}] auto-unfollowed resolved topic: ${unfollow.topic}")
						topics = bot.session.user_topics.keep_if(|t| !(t.stream_id == unfollow.stream_id and topic_eq(t.topic_name, unfollow.topic)))
						{ ..bot, session: { ..bot.session, user_topics: topics } }
					}
					Err(err) => {
						log!("[${bot.name}] auto-unfollow failed for ${unfollow.topic}: ${Str.inspect(err)}")
						bot
					}
				}
			unfollow_each!(rest, updated)
		}
	}

# --- pure helpers ---

is_followed : List(Events.UserTopic), I64, Str -> Bool
is_followed = |topics, stream_id, topic|
	topics.any(|t| t.stream_id == stream_id and topic_eq(t.topic_name, topic) and t.visibility_policy == Events.followed_policy)

## Topic comparison, ASCII-caseless (Zulip topics are case-insensitive; the
## TS listener lowercases — full Unicode folding isn't available here).
topic_eq : Str, Str -> Bool
topic_eq = |a, b| Str.caseless_ascii_equals(a, b)

epoch_secs_iso : I64 -> Str
epoch_secs_iso = |secs|
# message timestamps are epoch seconds, always positive
	Utc.to_iso_8601(secs.to_u128_wrap() * 1_000_000_000)

# --- inbox IO ---

inbox_path : InboxTarget, Str -> Str
inbox_path = |target, bot_name| "${target.home}/.claude/teams/${target.team}/inboxes/${bot_name}.json"

## Append an entry to a bot's inbox file, creating the directory as needed.
## An entry for an already-delivered Zulip message is skipped (Duplicate).
write_inbox! : InboxTarget, Str, Inbox.Entry => Try([Written, Duplicate], _)
write_inbox! = |target, bot_name, entry| {
	dir = "${target.home}/.claude/teams/${target.team}/inboxes"
	Path.create_all!(Path.unix(dir))?
	path = Path.unix(inbox_path(target, bot_name))
	existing = 
		if Path.exists!(path)? {
			Path.read_utf8!(path)?
		} else {
			""
		}
	if Inbox.has_message_id(existing, entry.zulip_message_id) {
		Ok(Duplicate)
	} else {
		updated = Inbox.append_to_array(existing, Inbox.entry_json(entry))
			? |_| InboxNotAnArray(inbox_path(target, bot_name))
		Path.write_utf8!(path, updated)?
		Ok(Written)
	}
}

now_iso! : () => Str
now_iso! = || Utc.to_iso_8601(Utc.now!())

# --- caches ---

## Fetch the channel list via the first available bot (any bot can see
## public streams). Failure is non-fatal: resolution refreshes on miss.
fetch_channels! : List(BotWatch) => List(Channels.Channel)
fetch_channels! = |bots|
	match bots {
		[] => []
		[bot, ..] =>
			match bot.client.list_channels!() {
				Ok(channels) => channels
				Err(err) => {
					log!("channel list failed: ${Str.inspect(err)}")
					[]
				}
			}
		}

fetch_members! : List(BotWatch) => List(Users.Member)
fetch_members! = |bots|
	match bots {
		[] => []
		[bot, ..] =>
			match bot.client.list_members!() {
				Ok(members) => members
				Err(err) => {
					log!("member list failed: ${Str.inspect(err)}")
					[]
				}
			}
		}

## Resolve a stream id to its name, refreshing the cache once on a miss
## (e.g. a channel created after startup). A stream that's still unknown
## after refresh gets a placeholder name rather than dropping the message.
resolve_stream_name! : List(Channels.Channel), I64, Client.Client => { name : Str, channels : List(Channels.Channel) }
resolve_stream_name! = |channels, stream_id, client|
	match channels.find_first(|c| c.stream_id == stream_id) {
		Ok(channel) => { name: channel.name, channels }
		Err(_) =>
			match client.list_channels!() {
				Ok(fresh) => {
					name = match fresh.find_first(|c| c.stream_id == stream_id) {
						Ok(channel) => channel.name
						Err(_) => "stream-${I64.to_str(stream_id)}"
					}
					{ name, channels: fresh }
				}
				Err(err) => {
					log!("channel refresh failed: ${Str.inspect(err)}")
					{ name: "stream-${I64.to_str(stream_id)}", channels }
				}
			}
		}

resolve_member_name! : List(Users.Member), I64, Client.Client => { name : Str, members : List(Users.Member) }
resolve_member_name! = |members, user_id, client|
	match members.find_first(|m| m.user_id == user_id) {
		Ok(member) => { name: member.full_name, members }
		Err(_) =>
			match client.list_members!() {
				Ok(fresh) => {
					name = match fresh.find_first(|m| m.user_id == user_id) {
						Ok(member) => member.full_name
						Err(_) => "user ${I64.to_str(user_id)}"
					}
					{ name, members: fresh }
				}
				Err(err) => {
					log!("member refresh failed: ${Str.inspect(err)}")
					{ name: "user ${I64.to_str(user_id)}", members }
				}
			}
		}

# --- effectful setup + adapters (duplicated from the dispatcher app; local
# --- modules can't be shared across app directories without a package) ---

## Register a session per teammate. Failures are logged and collected in
## `unregistered` so the sweep loop keeps retrying them.
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
					bot = { name: teammate.name, email: teammate.bot_email, client, session, unfollows: [] }
					init_bots!(site, rest, { ..done, bots: done.bots.append(bot) })
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

read_teammates! : Str => Try(List(Teammate), _)
read_teammates! = |db_path|
	Sqlite.query_many!({
		path: Path.unix(db_path),
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

## Derive the state-DB directory slug the same way state/db.ts does:
## the absolute repo path with every '/' replaced by '-'.
repo_slug : Str -> Str
repo_slug = |repo_root|
	Str.from_utf8_lossy(Str.to_utf8(repo_root).map(|b| if b == 47 45 else b))

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

## Best-effort: a failed stdout write must not kill the long-running
## listener, so write errors are deliberately dropped.
log! : Str => {}
log! = |msg|
	match Stdout.line!("[listener] ${msg}") {
		Ok({}) => {}
		Err(_) => {}
	}

# --- tests for the pure helpers ---

expect
	is_followed([{ stream_id: 7, topic_name: "pr-9", visibility_policy: 3 }], 7, "PR-9")
expect
	!is_followed([{ stream_id: 7, topic_name: "pr-9", visibility_policy: 0 }], 7, "pr-9")
expect
	!is_followed([{ stream_id: 7, topic_name: "pr-9", visibility_policy: 3 }], 8, "pr-9")

expect topic_eq("PR-9", "pr-9")
expect !topic_eq("pr-9", "pr-10")

expect epoch_secs_iso(0) == "1970-01-01T00:00:00Z"

# resolving a topic schedules an unfollow when it was followed
expect
	{
		bot = test_bot([{ stream_id: 7, topic_name: "pr-9", visibility_policy: 3 }], [])
		moved = handle_topic_moved({ stream_id: 7, subject: "✔ pr-9", orig_subject: Ok("pr-9") }, bot, 1000)
		moved.unfollows == [{ stream_id: 7, topic: "✔ pr-9", due_ms: 1000 + 60_000 }]
	}

# an unfollowed topic's resolution schedules nothing
expect
	{
		bot = test_bot([], [])
		moved = handle_topic_moved({ stream_id: 7, subject: "✔ pr-9", orig_subject: Ok("pr-9") }, bot, 1000)
		moved.unfollows == []
	}

# re-resolving replaces the pending timer rather than stacking a second one
expect
	{
		bot = test_bot(
			[{ stream_id: 7, topic_name: "pr-9", visibility_policy: 3 }],
			[{ stream_id: 7, topic: "✔ pr-9", due_ms: 500 }],
		)
		moved = handle_topic_moved({ stream_id: 7, subject: "✔ pr-9", orig_subject: Ok("pr-9") }, bot, 1000)
		moved.unfollows == [{ stream_id: 7, topic: "✔ pr-9", due_ms: 61_000 }]
	}

# un-resolving cancels the pending unfollow
expect
	{
		bot = test_bot(
			[{ stream_id: 7, topic_name: "pr-9", visibility_policy: 3 }],
			[{ stream_id: 7, topic: "✔ pr-9", due_ms: 500 }],
		)
		moved = handle_topic_moved({ stream_id: 7, subject: "pr-9", orig_subject: Ok("✔ pr-9") }, bot, 1000)
		moved.unfollows == []
	}

# a plain rename of a followed topic neither schedules nor cancels
expect
	{
		bot = test_bot(
			[{ stream_id: 7, topic_name: "pr-9", visibility_policy: 3 }],
			[{ stream_id: 9, topic: "✔ other", due_ms: 500 }],
		)
		moved = handle_topic_moved({ stream_id: 7, subject: "pr-nine", orig_subject: Ok("pr-9") }, bot, 1000)
		moved.unfollows == [{ stream_id: 9, topic: "✔ other", due_ms: 500 }]
	}

## A BotWatch for pure tests (the client is never called).
test_bot : List(Events.UserTopic), List(PendingUnfollow) -> BotWatch
test_bot = |user_topics, unfollows| {
	name: "testbot",
	email: "testbot@x.com",
	client: Client.new({ site: "https://x.zulipchat.com", email: "testbot@x.com", api_key: "k" }, |_req| Ok(Response.from_status(200))),
	session: { queue_id: "q:test", last_event_id: -1, user_topics },
	unfollows,
}
