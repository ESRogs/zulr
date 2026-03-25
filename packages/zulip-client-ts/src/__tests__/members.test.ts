import { describe, expect, test } from 'bun:test'
import type { DisplayName, Email, EventId, Member, RealmUserEvent, UserId } from 'zulip-ts'
import {
  applyRealmUserEvent,
  emptyMembers,
  initMembers,
  resolveName,
  resolveUserId,
} from '../members.ts'

function uid(n: number): UserId {
  return n as UserId
}
function eid(n: number): EventId {
  return n as EventId
}

function makeMember(id: number, name: string): Member {
  return {
    user_id: uid(id),
    email: `${name.toLowerCase()}@example.com` as Email,
    full_name: name as DisplayName,
  }
}

describe('initMembers', () => {
  test('builds map from member list', () => {
    const members = [makeMember(1, 'Alice'), makeMember(2, 'Bob')]
    const state = initMembers(members)

    expect(state.byId.size).toBe(2)
    expect(state.byName.size).toBe(2)
    expect(resolveUserId(state, uid(1))).toBe('Alice' as DisplayName)
    expect(resolveUserId(state, uid(2))).toBe('Bob' as DisplayName)
  })
})

describe('resolveUserId', () => {
  test('returns undefined for unknown user', () => {
    const state = emptyMembers()
    expect(resolveUserId(state, uid(99))).toBeUndefined()
  })
})

describe('resolveName', () => {
  test('finds member by display name', () => {
    const state = initMembers([makeMember(1, 'Alice'), makeMember(2, 'Bob')])
    const member = resolveName(state, 'Alice' as DisplayName)

    expect(member).toBeDefined()
    expect(member!.user_id).toBe(uid(1))
  })

  test('returns undefined for unknown name', () => {
    const state = initMembers([makeMember(1, 'Alice')])
    expect(resolveName(state, 'Charlie' as DisplayName)).toBeUndefined()
  })
})

describe('applyRealmUserEvent', () => {
  test('adds new user on op=add', () => {
    const state = emptyMembers()
    applyRealmUserEvent(state, {
      type: 'realm_user',
      id: eid(1),
      op: 'add',
      person: makeMember(3, 'Charlie'),
    } as RealmUserEvent)

    expect(resolveUserId(state, uid(3))).toBe('Charlie' as DisplayName)
    expect(resolveName(state, 'Charlie' as DisplayName)?.user_id).toBe(uid(3))
  })

  test('updates existing user on op=update', () => {
    const state = initMembers([makeMember(1, 'Alice')])
    applyRealmUserEvent(state, {
      type: 'realm_user',
      id: eid(1),
      op: 'update',
      person: { user_id: uid(1), full_name: 'Alice Smith' as DisplayName },
    } as RealmUserEvent)

    expect(resolveUserId(state, uid(1))).toBe('Alice Smith' as DisplayName)
    // Email preserved from original
    expect(state.byId.get(uid(1))!.email).toBe('alice@example.com' as Email)
  })

  test('updates reverse index on name change', () => {
    const state = initMembers([makeMember(1, 'Alice')])
    applyRealmUserEvent(state, {
      type: 'realm_user',
      id: eid(1),
      op: 'update',
      person: { user_id: uid(1), full_name: 'Alice Smith' as DisplayName },
    } as RealmUserEvent)

    expect(resolveName(state, 'Alice' as DisplayName)).toBeUndefined()
    expect(resolveName(state, 'Alice Smith' as DisplayName)?.user_id).toBe(uid(1))
  })

  test('removes user on op=remove', () => {
    const state = initMembers([makeMember(1, 'Alice')])
    applyRealmUserEvent(state, {
      type: 'realm_user',
      id: eid(1),
      op: 'remove',
      person: { user_id: uid(1) },
    } as RealmUserEvent)

    expect(resolveUserId(state, uid(1))).toBeUndefined()
    expect(resolveName(state, 'Alice' as DisplayName)).toBeUndefined()
  })

  test('ignores update for unknown user', () => {
    const state = emptyMembers()
    applyRealmUserEvent(state, {
      type: 'realm_user',
      id: eid(1),
      op: 'update',
      person: { user_id: uid(99), full_name: 'Ghost' as DisplayName },
    } as RealmUserEvent)

    expect(state.byId.size).toBe(0)
    expect(state.byName.size).toBe(0)
  })
})
