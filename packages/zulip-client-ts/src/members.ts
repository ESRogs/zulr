import type { DisplayName, Member, RealmUserEvent, UserId } from 'zulip-ts'

export type MembersState = Map<UserId, Member>

export function initMembers(members: readonly Member[]): MembersState {
  return new Map(members.map((m) => [m.user_id, m]))
}

export function emptyMembers(): MembersState {
  return new Map()
}

/** Apply a realm_user event — add, update, or remove a member. */
export function applyRealmUserEvent(state: MembersState, event: RealmUserEvent): void {
  const { op, person } = event

  if (op === 'add') {
    state.set(person.user_id, person as Member)
  } else if (op === 'update') {
    const existing = state.get(person.user_id)
    if (existing) {
      state.set(person.user_id, { ...existing, ...person })
    }
  } else if (op === 'remove') {
    state.delete(person.user_id)
  }
}

export function resolveUserId(state: MembersState, id: UserId): DisplayName | undefined {
  return state.get(id)?.full_name
}

export function resolveName(state: MembersState, name: DisplayName): Member | undefined {
  for (const member of state.values()) {
    if (member.full_name === name) return member
  }
  return undefined
}
