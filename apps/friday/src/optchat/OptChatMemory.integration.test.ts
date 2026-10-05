/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide -- Bun is the SQLite integration test boundary. */
import { test, expect } from 'bun:test'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as Effect from 'effect/Effect'
import * as Deferred from 'effect/Deferred'
import * as Fiber from 'effect/Fiber'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { makeOptChatMemory } from './OptChatMemory.ts'
import { PiDurableError } from '../harness/pi/PiDurableError.ts'

test('memory survives service recreation, deduplicates sources, and isolates owners', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0
      const compress = () =>
        Effect.sync(() => {
          calls++
          return 'user: Keep the chosen deployment region and retry policy.'
        })
      const memory = yield* makeOptChatMemory(compress, 90)
      yield* memory.append('chan', [
        {
          sourceKey: '1',
          kind: 'user',
          text: 'Choose Tokyo. '.repeat(60),
          date: '2026-10-05T00:00:00Z',
        },
        { sourceKey: '2', kind: 'talk', text: 'Tokyo selected.', date: '2026-10-05T00:01:00Z' },
        { sourceKey: '3', kind: 'user', text: 'Retry twice.', date: '2026-10-05T00:02:00Z' },
      ])
      yield* memory.append('pinn', [
        { sourceKey: '1', kind: 'user', text: 'Choose Paris.', date: '2026-10-05T00:00:00Z' },
      ])
      yield* memory.append('chan', [
        { sourceKey: '1', kind: 'user', text: 'Duplicate ignored.', date: '2026-10-05T00:00:00Z' },
      ])
      const view = yield* memory.settle('chan')
      const before = calls
      const reopened = yield* makeOptChatMemory(compress, 90)
      expect(yield* reopened.settle('chan')).toBe(view)
      expect(calls).toBe(before)
      expect(yield* reopened.zoom('chan', 0, 1)).toContain('Choose Tokyo.')
      expect(yield* reopened.zoom('chan', 0, 1)).not.toContain('Duplicate')
      expect(yield* reopened.zoom('pinn', 0, 1)).toContain('Choose Paris.')
      expect(yield* reopened.zoom('pinn', 1, 1)).toBe('No line 1+1.')
      expect(yield* reopened.zoom('chan', 1, 2)).toBe('No line 1+2.')
      expect(yield* reopened.date('chan', 2)).toBe('2026-10-05T00:02:00Z')
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:' }))),
  ))

test('failed compression leaves history intact and resumes missing summaries', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let fail = true
      const memory = yield* makeOptChatMemory(() =>
        fail
          ? Effect.fail(new PiDurableError({ operation: 'test', detail: 'offline' }))
          : Effect.succeed('user: Remember Tokyo.'),
      )
      yield* memory.append('chan', [
        {
          sourceKey: '1',
          kind: 'user',
          text: 'Remember Tokyo. '.repeat(80),
          date: '2026-10-05T00:00:00Z',
        },
      ])
      expect((yield* Effect.exit(memory.settle('chan')))._tag).toBe('Failure')
      expect(yield* memory.zoom('chan', 0, 1)).toContain('Remember Tokyo.')
      fail = false
      expect(yield* memory.settle('chan')).toContain('user: Remember Tokyo.')
      const sql = yield* SqlClient.SqlClient
      expect((yield* sql`SELECT * FROM optchat_nodes`).length).toBe(1)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:' }))),
  ))

test('successful sibling summaries survive a failed merge job', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let failMerge = true
      const memory = yield* makeOptChatMemory((input) =>
        input.merge && failMerge
          ? Effect.fail(new PiDurableError({ operation: 'test', detail: 'merge offline' }))
          : Effect.succeed(`user: ${'Tokyo '.repeat(47)}`),
      )
      yield* memory.append(
        'chan',
        Array.from({ length: 3 }, (_, index) => ({
          sourceKey: String(index),
          kind: 'user' as const,
          text: `${index}: ${'Keep Tokyo. '.repeat(70)}`,
          date: '2026-10-05T00:00:00Z',
        })),
      )
      expect((yield* Effect.exit(memory.pump('chan')))._tag).toBe('Failure')
      const sql = yield* SqlClient.SqlClient
      expect((yield* sql`SELECT * FROM optchat_nodes WHERE count = 1`).length).toBe(3)
      failMerge = false
      yield* memory.pump('chan')
      expect((yield* sql`SELECT * FROM optchat_nodes WHERE count = 2`).length).toBe(1)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:' }))),
  ))

test('appends and refills leaf jobs while an older merge is still running', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const mergeStarted = yield* Deferred.make<void>()
        const releaseMerge = yield* Deferred.make<void>()
        const newLeafStarted = yield* Deferred.make<void>()
        const memory = yield* makeOptChatMemory((input) =>
          Effect.gen(function* () {
            if (input.merge) {
              yield* Deferred.succeed(mergeStarted, undefined)
              yield* Deferred.await(releaseMerge)
            }
            if (input.source.startsWith('user: 3:'))
              yield* Deferred.succeed(newLeafStarted, undefined)
            return `user: ${'Tokyo '.repeat(47)}`
          }),
        )
        const message = (id: number) => ({
          sourceKey: String(id),
          kind: 'user' as const,
          text: `${id}: ${'Keep Tokyo. '.repeat(70)}`,
          date: '2026-10-05T00:00:00Z',
        })
        yield* memory.append('chan', [message(0), message(1), message(2)])
        const pump = yield* memory.pump('chan').pipe(Effect.forkChild)
        yield* Deferred.await(mergeStarted)
        yield* memory.append('chan', [message(3)]).pipe(Effect.timeout('2 seconds'))
        yield* Deferred.await(newLeafStarted).pipe(Effect.timeout('2 seconds'))
        yield* Deferred.succeed(releaseMerge, undefined)
        yield* Fiber.join(pump)
        expect(yield* memory.zoom('chan', 3, 1)).toContain('3: Keep Tokyo.')
        expect(yield* memory.settle('chan')).toContain('3+1|')
      }),
    ).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:' }))),
  ))
