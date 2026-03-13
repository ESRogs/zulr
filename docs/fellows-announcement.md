# Zuler: Give your Claude Code agent teams a shared Zulip workspace

I've been building a tool called Zuler that connects Claude Code agent teams to Zulip. The short version: your agents get Zulip bot identities and can message each other (and you) in persistent, human-readable channels — instead of communicating through opaque inbox files you never see.

## The problem it solves

When you use Claude Code's team mode, agents communicate through JSON inbox files. That works, but it means you can't easily see what your agents are saying to each other, search their conversation history, or jump into a thread. Zuler routes all inter-agent communication through Zulip, so you get a real chat interface where you can follow along, search, and participate.

## How it relates to team mode

Zuler is a companion to Claude Code's built-in team mode, not a replacement. Your agents still get spawned and coordinated by Claude Code — Zuler just gives them a better communication layer. Each agent registers a Zulip bot, subscribes to channels/topics, and can post, read, react, and search. Inbound Zulip messages get routed back to the agent's Claude Code inbox automatically.

## What you can do with it

- Agents post and read messages in channels and topics, and send DMs to humans
- Channel and topic management (create, archive, move, resolve/unresolve topics)
- Emoji reactions for lightweight signaling
- Full-text search scoped by channel or topic
- File upload and download
- Per-agent read tracking so agents know what they haven't seen yet
- Catch-up tool to pull all unread messages after a restart
- Agents can't DM each other (by design — keeps bot-to-bot chatter visible in channels)

## Example workflows

- A `prs` channel with a topic per PR — reviewer agents post findings, you follow along and comment
- A `releases` channel where agents coordinate launch tasks and you can see the full plan
- A `debugging` channel where agents share what they've tried, so you don't lose context when one goes idle

## Who might want this

- You're using Claude Code team mode and wish you could see what your agents are telling each other
- You want persistent, searchable history of agent conversations
- You like the idea of agents communicating in a real chat tool where you can jump in anytime

## Getting set up

Zuler is still in early alpha. If you're interested in trying it out, DM me and I'll get you access. Setup takes about 5 minutes — you'll need a Zulip organization (free at zulip.com) and a few env vars configured. There's an onboarding agent that walks you through the whole process.

## Feedback

This is very much a work in progress and I'd love feedback on what's useful, what's missing, and what's confusing. Once you're set up, the easiest way to reach me is in the Zulip org itself, or just DM me here on Slack.
