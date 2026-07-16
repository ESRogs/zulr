## Pure wake-up evaluation, matching Zulip's notification trigger logic
## (ported from zulip-client-ts notifications.ts):
##   DM → always notify; @-mention or wildcard mention (from flags) → notify;
##   topic followed (visibility policy 3) → notify; otherwise silent.

import Events
import Messages

Notify := [].{

	Reason : [Dm, Mentioned, WildcardMentioned, FollowedTopic, Silent]

	followed_policy : I64
	followed_policy = 3

	## Decide whether a message should wake its recipient, and why.
	evaluate : Messages.Message, List(Events.UserTopic) -> Reason
	evaluate = |message, user_topics|
		match message {
			Private(_) => Dm
			Stream({ flags, stream_id, topic, .. }) => {
				if flags.contains("mentioned") {
					Mentioned
				} else if flags.contains("wildcard_mentioned") {
					WildcardMentioned
				} else if is_followed(user_topics, stream_id, topic) {
					FollowedTopic
				} else {
					Silent
				}
			}
		}

	is_followed : List(Events.UserTopic), I64, Str -> Bool
	is_followed = |user_topics, stream_id, topic|
		user_topics.any(
			|ut| ut.stream_id == stream_id and ut.topic_name == topic and ut.visibility_policy == followed_policy,
		)
}

# --- tests ---

followed_pr42 : List(Events.UserTopic)
followed_pr42 = [{ stream_id: 7, topic_name: "pr-42", visibility_policy: 3 }]

expect Notify.evaluate(Private({ id: 1, sender_id: 2, flags: [] }), []) == Dm

expect
	Notify.evaluate(Stream({ id: 1, sender_id: 2, flags: ["mentioned"], stream_id: 9, topic: "x" }), [])
		== Mentioned

expect
	Notify.evaluate(Stream({ id: 1, sender_id: 2, flags: ["wildcard_mentioned"], stream_id: 9, topic: "x" }), [])
		== WildcardMentioned

expect
	Notify.evaluate(Stream({ id: 1, sender_id: 2, flags: [], stream_id: 7, topic: "pr-42" }), followed_pr42)
		== FollowedTopic

# same topic name in a different stream is not followed
expect
	Notify.evaluate(Stream({ id: 1, sender_id: 2, flags: [], stream_id: 8, topic: "pr-42" }), followed_pr42)
		== Silent

# muted (policy 1) does not count as followed
expect
	Notify.evaluate(
		Stream({ id: 1, sender_id: 2, flags: [], stream_id: 7, topic: "pr-42" }),
		[{ stream_id: 7, topic_name: "pr-42", visibility_policy: 1 }],
	)
		== Silent

expect Notify.evaluate(Stream({ id: 1, sender_id: 2, flags: [], stream_id: 9, topic: "x" }), []) == Silent
