# Zulr Team Best Practices

Default conventions for agent teams communicating over Zulip via zulr.

## Reaction Semantics

Use emoji reactions as lightweight coordination signals. Reactions are visible
to all teammates following the topic.

| Emoji | Meaning | When to use |
|-------|---------|-------------|
| :eyes: | "Working on it" | React when you start working on a request so others know you're on it |
| :check: | "Done" | React when you've completed what was asked |
| :thumbs_up: | "Acknowledged" | React when you've read and understood a message but no action is needed from you |

**The :eyes: / :check: workflow.** When someone asks you to do something:
1. React :eyes: immediately so others know you're working on it.
2. Do the work.
3. Signal completion — one of:
   - React :check: on the original request — use this when the task is
     straightforward and there's nothing to discuss about the result.
   - Reply to the topic — use this when the result merits explanation,
     includes deliverables to share, or raises follow-up questions.
   - Both — react :check: *and* reply when you want to make completion
     scannable at a glance (via the reaction) while also providing detail
     in the thread.

**When to react vs. reply (general guidance):**
- Only react to messages directed at you or where acknowledgment is
  meaningful. Reacting to every message creates noise.
- React when no words are needed — acknowledgment, status signals, votes.
- Reply when you have information to share, questions to ask, or decisions to
  communicate.

## Channels and Topics

### general

Team-wide conversations. Key topics:

- **announcements** — Important updates that affect the whole team. Keep it
  concise. React with :thumbs_up: to confirm you've seen an announcement.
- **team** — Coordination, staffing, and process discussions.

### prs

PR review coordination. **One topic per PR**, named `<number> – <short title>`
(e.g., `59 – Zulip-native subs`). Keep topic names short.

Workflow:
1. When a PR is ready for review, post a summary with a link to the PR and
   tag reviewers as appropriate.
2. Substantive review comments go on GitHub, not Zulip. The Zulip topic is
   for meta-level coordination (routing reviews, pinging for re-reviews).
3. If a longer discussion is needed, it can happen in the topic, but
   decisions should be posted back to GitHub.
4. The PR on GitHub should be self-contained — you should be able to
   understand all decisions by reading it.
5. **Do not merge without the user's explicit approval** — even if the
   reviewer approves.
6. Default to squash merge: `gh pr merge --squash --delete-branch`.
7. When a PR is merged, resolve the PR topic in prs.

When mentioning a PR in Zulip, link to the PR topic (e.g.
`#**prs>109 – merge route/inbox logs**`) rather than the GitHub URL. The PR
topic is the canonical Zulip location for that PR's discussion, and it links
to the GitHub PR from there.

### Other channels

Use the `channels` tool for the current list. Some common ones:

- **releases** — Release coordination and announcements.
- **sandbox** — Experimentation. Feel free to test things here.
- **zulip-integration** — Discussion about Zulip API and integration work.

## Communication Preferences

### Zulip over SendMessage

Default to posting on Zulip rather than using SendMessage for teammate
communication. Zulip messages are:
- Visible to the whole team (or relevant subscribers)
- Searchable and persistent
- Readable by the user in the Zulip UI

Use SendMessage only for Claude Code-internal coordination that doesn't need
to be visible on Zulip (e.g., asking team-lead to spawn a new agent).

### Catching Up

After a restart or long idle period, use the `catch-up` tool with
`unreadOnly: true` to see what you missed. React to important messages to
signal you're back and have read them.

### Reading Before Posting

Always read recent messages in a topic before replying. The `read` and
`catch-up` tools mark messages as read on Zulip. If you skip this step, the
`post` tool will block you until you catch up — this prevents stale replies
that ignore intervening discussion.

### Reply Where You Were Messaged

Reply in the same way you were messaged:
- If the user talks to you directly in Claude Code, reply in text.
- If a teammate messages you via SendMessage, reply via SendMessage.
- If you get a message from Zulip, reply in the same channel/topic or DM.

Don't forward Zulip conversations to SendMessage or vice versa.

### Avoid Duplicate Posts

Before posting, check whether a teammate has already made the same point.
This applies especially in busy topics where multiple teammates are active:

- When the `post` tool's unread gate makes you read new messages before
  posting, **actually revise your reply** based on what you just read. If
  another teammate already answered the question or made your point, don't
  post a near-duplicate — either add something new or skip your reply
  entirely.
- If a teammate is already following a topic (e.g., because they were
  @-mentioned there), don't repeat or summarize what someone else said to
  them in the same topic. They can read it themselves.

## Writing Style

- Be direct and concise. Lead with the answer or decision.
- Use Zulip markdown: `**bold**`, `*italic*`, `` `code` ``, code blocks with
  language tags.
- Quote previous messages with `> ` or Zulip's quote syntax when referencing
  them.
- @-mention teammates when you need their attention: `@**name**`. This
  auto-follows them on the topic.

## Git and PRs

- Default to squash merge: `gh pr merge --squash --delete-branch`.
- Never merge without the user's explicit approval.
- PR descriptions should explain the "why," not just the "what."
- Tag reviewers as appropriate when a PR is ready.

### Worktrees

**Do not use `EnterWorktree` or `ExitWorktree`** unless explicitly
instructed by the team lead or the user. These tools change your working
directory to a different git worktree, which can conflict with another
teammate's work.

How you're set up depends on how you were spawned:
- **mngr-spawned agents** get their own dedicated worktree. You're
  already isolated — stay in your worktree.
- **Team-mode agents** share the team lead's worktree. You may end up in
  a worktree that belongs to another teammate. If so, ask the team lead
  or user for guidance rather than switching worktrees yourself.
