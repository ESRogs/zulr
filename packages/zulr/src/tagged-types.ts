import { err, ok, type Result } from 'neverthrow'
import type { Tagged } from 'type-fest'
import type { DisplayName } from 'zulip-ts'

/** Name of a registered teammate (maps to a Zulip bot). */
export type TeammateName = Tagged<string, 'TeammateName'>

/** Claude Code team name (matches ZULR_TEAM env var). */
export type TeamName = Tagged<string, 'TeamName'>

/** Convert a TeammateName to a Zulip DisplayName for bot creation. */
export function teammateToDisplayName(name: TeammateName): Result<DisplayName, string> {
  if (name.length === 0) return err('teammate name is empty')
  return ok(name as string as DisplayName)
}
