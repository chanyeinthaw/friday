/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- Bun SQLite integration tests cannot run under @effect/vitest because Node cannot load bun:sqlite. */

import { expect, test } from 'bun:test'
import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import { Message, type QueueEntry } from 'chat'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeSqliteChatStateAdapter } from './SqliteChatStateAdapter.ts'

const withAdapter = async <A>(
  use: (adapter: Awaited<ReturnType<typeof makeAdapter>>) => Promise<A>,
): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-chat-state-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* makeSqliteChatStateAdapter()
      yield* Effect.promise(() => adapter.connect())
      return yield* Effect.promise(() => use(adapter))
    }),
  ).pipe(Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunCrypto.layer)))
  const result = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })
  return result
}

const makeAdapter = () =>
  Effect.runPromise(
    Effect.scoped(
      makeSqliteChatStateAdapter().pipe(
        Effect.provide(
          Layer.mergeAll(SqliteClient.layer({ filename: ':memory:' }), BunCrypto.layer),
        ),
      ),
    ),
  )

test('persists Chat SDK subscriptions', async () => {
  await withAdapter(async (adapter) => {
    expect(await adapter.isSubscribed('discord:guild:channel')).toBe(false)
    await adapter.subscribe('discord:guild:channel')
    expect(await adapter.isSubscribed('discord:guild:channel')).toBe(true)
    await adapter.unsubscribe('discord:guild:channel')
    expect(await adapter.isSubscribed('discord:guild:channel')).toBe(false)
  })
})

test('enforces Chat SDK lock ownership and expiry', async () => {
  await withAdapter(async (adapter) => {
    const first = await adapter.acquireLock('discord:guild:channel', 25)
    expect(first).not.toBeNull()
    expect(await adapter.acquireLock('discord:guild:channel', 25)).toBeNull()
    if (!first) return

    expect(await adapter.extendLock({ ...first, token: 'not-the-owner' }, 50)).toBe(false)
    expect(await adapter.extendLock(first, 50)).toBe(true)
    await adapter.releaseLock({ ...first, token: 'not-the-owner' })
    expect(await adapter.acquireLock('discord:guild:channel', 25)).toBeNull()
    await adapter.releaseLock(first)
    expect(await adapter.acquireLock('discord:guild:channel', 25)).not.toBeNull()

    const expiring = await adapter.acquireLock('discord:guild:expiring', 20)
    expect(expiring).not.toBeNull()
    await Bun.sleep(30)
    expect(await adapter.acquireLock('discord:guild:expiring', 20)).not.toBeNull()
  })
})

test('stores bounded ordered lists with expiry', async () => {
  await withAdapter(async (adapter) => {
    await adapter.appendToList('history', 'first', { maxLength: 2 })
    await adapter.appendToList('history', 'second', { maxLength: 2 })
    await adapter.appendToList('history', 'third', { maxLength: 2 })
    expect(await adapter.getList<string>('history')).toEqual(['second', 'third'])

    await adapter.appendToList('expiring-history', 'temporary', { ttlMs: 20 })
    expect(await adapter.getList<string>('expiring-history')).toEqual(['temporary'])
    await Bun.sleep(30)
    expect(await adapter.getList<string>('expiring-history')).toEqual([])
  })
})

test('stores a bounded FIFO queue and discards expired entries', async () => {
  await withAdapter(async (adapter) => {
    const now = Date.now()
    const entry = (id: string, expiresAt = now + 1_000): QueueEntry => ({
      enqueuedAt: now,
      expiresAt,
      message: new Message({
        attachments: [],
        author: {
          userId: 'user-1',
          userName: 'chan',
          fullName: 'Chan',
          isBot: false,
          isMe: false,
        },
        formatted: { type: 'root', children: [] },
        id,
        metadata: { dateSent: new Date(now), edited: false },
        raw: {},
        text: id,
        threadId: 'thread-queue',
      }),
    })
    await adapter.enqueue('thread-queue', entry('first'), 2)
    await adapter.enqueue('thread-queue', entry('second'), 2)
    expect(await adapter.enqueue('thread-queue', entry('third'), 2)).toBe(2)
    expect((await adapter.dequeue('thread-queue'))?.message.id).toBe('second')
    expect((await adapter.dequeue('thread-queue'))?.message.id).toBe('third')
    expect(await adapter.dequeue('thread-queue')).toBeNull()

    await adapter.enqueue('thread-expired', entry('expired', now - 1), 2)
    expect(await adapter.queueDepth('thread-expired')).toBe(0)
  })
})

test('atomically deduplicates unexpired cache entries and accepts them after expiry', async () => {
  await withAdapter(async (adapter) => {
    const key = 'dedupe:discord:message-1'
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => adapter.setIfNotExists(key, true, 60_000)),
    )
    expect(attempts.filter(Boolean)).toHaveLength(1)

    await adapter.set(key, false, 0)
    expect(await adapter.setIfNotExists(key, true, 60_000)).toBe(true)
    expect(await adapter.get<boolean>(key)).toBe(true)
  })
})
