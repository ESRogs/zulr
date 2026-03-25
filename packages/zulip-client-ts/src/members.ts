import type { DisplayName, Member, RealmUserEvent, UserId } from 'zulip-ts'

export type MembersState = {
  readonly byId: Map<UserId, Member>
  readonly byName: Map<DisplayName, UserId>
}

/** Build members state from a list of members, indexing by both ID and display name. */
export function initMembers(members: readonly Member[]): MembersState {
  const byId = new Map<UserId, Member>()
  const byName = new Map<DisplayName, UserId>()
  for (const m of members) {
    byId.set(m.user_id, m)
    byName.set(m.full_name, m.user_id)
  }
  return { byId, byName }
}

/** Create an empty members state. */
export function emptyMembers(): MembersState {
  return { byId: new Map(), byName: new Map() }
}

/**
 * Apply a realm_user event to members state.
 * Handles add, update (including name changes), and remove operations.
 */
export function applyRealmUserEvent(state: MembersState, event: RealmUserEvent): void {
  const { op, person } = event

  if (op === 'add') {
    const member = person as Member
    state.byId.set(member.user_id, member)
    state.byName.set(member.full_name, member.user_id)
  } else if (op === 'update') {
    const existing = state.byId.get(person.user_id)
    if (existing) {
      if (person.full_name && person.full_name !== existing.full_name) {
        state.byName.delete(existing.full_name)
      }
      const updated = { ...existing, ...person }
      state.byId.set(person.user_id, updated)
      state.byName.set(updated.full_name, person.user_id)
    }
  } else if (op === 'remove') {
    const existing = state.byId.get(person.user_id)
    if (existing) {
      state.byName.delete(existing.full_name)
    }
    state.byId.delete(person.user_id)
  }
}

/** Resolve a user ID to a display name. Returns undefined if the user is not in state. */
export function resolveUserId(state: MembersState, id: UserId): DisplayName | undefined {
  return state.byId.get(id)?.full_name
}

/** Look up a member by display name. O(1) via reverse index. */
export function resolveName(state: MembersState, name: DisplayName): Member | undefined {
  const userId = state.byName.get(name)
  if (userId === undefined) return undefined
  return state.byId.get(userId)
}
