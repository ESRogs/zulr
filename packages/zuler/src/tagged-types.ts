import type { Tagged } from 'type-fest'

/** Name of a registered teammate (maps to a Zulip bot). */
export type TeammateName = Tagged<string, 'TeammateName'>

/** Claude Code team name (matches ZULER_TEAM env var). */
export type TeamName = Tagged<string, 'TeamName'>
