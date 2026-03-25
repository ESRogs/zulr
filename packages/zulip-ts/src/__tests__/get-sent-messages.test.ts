import { describe, expect, mock, test } from 'bun:test'
import { ok, ResultAsync } from 'neverthrow'
import type { ZulipClient } from '../client.ts'
import { getSentMessages, type NarrowFilter } from '../messages.ts'
import type { Email, MessageId, UserId } from '../tagged-types.ts'

function mockClient(expectedNarrow: readonly NarrowFilter[]): ZulipClient {
  return {
    config: { site: 'https://test.zulipchat.com', email: '' as Email, apiKey: '' as never },
    request: mock((options: { params?: Record<string, unknown> }) => {
      const narrow = JSON.parse(String(options.params?.narrow ?? '[]'))
      expect(narrow).toEqual(expectedNarrow)
      return ResultAsync.fromSafePromise(
        Promise.resolve(ok({ result: 'success', msg: '', messages: [] })),
      )
    }),
  }
}

describe('getSentMessages', () => {
  test('uses sender narrow with email', async () => {
    const email = 'user@example.com' as Email
    const client = mockClient([{ operator: 'sender', operand: email }])

    const result = await getSentMessages(client, { sender: email })
    expect(result.isOk()).toBe(true)
    expect(client.request).toHaveBeenCalledTimes(1)
  })

  test('uses sender narrow with userId', async () => {
    const userId = 42 as UserId
    const client = mockClient([{ operator: 'sender', operand: userId }])

    const result = await getSentMessages(client, { sender: userId })
    expect(result.isOk()).toBe(true)
    expect(client.request).toHaveBeenCalledTimes(1)
  })

  test('prepends sender narrow to additional narrows', async () => {
    const userId = 42 as UserId
    const topicNarrow: NarrowFilter = { operator: 'topic', operand: 'design' }
    const client = mockClient([{ operator: 'sender', operand: userId }, topicNarrow])

    const result = await getSentMessages(client, { sender: userId, narrow: [topicNarrow] })
    expect(result.isOk()).toBe(true)
  })

  test('defaults to anchor=newest, numBefore=100, numAfter=0', async () => {
    const userId = 42 as UserId
    const client: ZulipClient = {
      config: { site: 'https://test.zulipchat.com', email: '' as Email, apiKey: '' as never },
      request: mock((options: { params?: Record<string, unknown> }) => {
        expect(options.params?.anchor).toBe('newest')
        expect(options.params?.num_before).toBe(100)
        expect(options.params?.num_after).toBe(0)
        return ResultAsync.fromSafePromise(
          Promise.resolve(ok({ result: 'success', msg: '', messages: [] })),
        )
      }),
    }

    await getSentMessages(client, { sender: userId })
    expect(client.request).toHaveBeenCalledTimes(1)
  })

  test('respects custom anchor and pagination', async () => {
    const userId = 42 as UserId
    const customAnchor = 999 as MessageId
    const client: ZulipClient = {
      config: { site: 'https://test.zulipchat.com', email: '' as Email, apiKey: '' as never },
      request: mock((options: { params?: Record<string, unknown> }) => {
        expect(options.params?.anchor).toBe('999')
        expect(options.params?.num_before).toBe(50)
        expect(options.params?.num_after).toBe(10)
        return ResultAsync.fromSafePromise(
          Promise.resolve(ok({ result: 'success', msg: '', messages: [] })),
        )
      }),
    }

    await getSentMessages(client, {
      sender: userId,
      anchor: customAnchor,
      numBefore: 50,
      numAfter: 10,
    })
    expect(client.request).toHaveBeenCalledTimes(1)
  })
})
