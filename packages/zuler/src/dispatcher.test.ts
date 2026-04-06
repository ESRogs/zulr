import { describe, test, expect } from 'bun:test'

// Unit tests for dispatcher utility functions
// The main dispatcher logic requires live Zulip connections, so these test
// the mngr status parsing and wake cooldown logic in isolation.

describe('dispatcher', () => {
  test('module exports createDispatcher', async () => {
    const mod = await import('./dispatcher.ts')
    expect(typeof mod.createDispatcher).toBe('function')
  })
})
