/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide -- Bun is the SQLite integration test boundary. */
import { test, expect } from 'bun:test'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { makeOptChatMemory } from './OptChatMemory.ts'
import { runStructuralMigrations } from '../persistence/Migrations.ts'
import { OptChatConfiguration, OptChatConfigurationLive } from '../config/OptChatConfiguration.ts'
import { importMappedInputs, mapPiSessionContent } from './OptChatPiImport.ts'

const line = (value: unknown): string => JSON.stringify(value)
const header = (id: string): string =>
  line({ type: 'session', version: 3, id, timestamp: '2026-10-05T00:00:00.000Z', cwd: '/work' })
const userEntry = (id: string, parentId: string | null, text: string, timestamp: number): string =>
  line({
    type: 'message',
    id,
    parentId,
    timestamp: '2026-10-05T00:01:00.000Z',
    message: { role: 'user', content: text, timestamp },
  })
const ts = (minute: number): number =>
  Date.parse(`2026-10-05T00:${String(minute).padStart(2, '0')}:00.000Z`)

const setupBinding = (memoryId: string) =>
  Effect.gen(function* () {
    yield* runStructuralMigrations()
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT OR IGNORE INTO platform_connections (connection_id, platform, name, enabled, created_at, updated_at) VALUES ('discord', 'discord', 'Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    const config = yield* OptChatConfiguration
    yield* config.add({
      id: memoryId,
      platform: 'discord',
      connectionId: 'discord',
      channelId: `channel-${memoryId}`,
      ownerUserId: `owner-${memoryId}`,
    })
    // Import must never summarize; a compressor call fails the test loudly.
    const memory = yield* makeOptChatMemory(() =>
      Effect.die('OptChat Pi import must not summarize'),
    )
    return { sql, memory }
  })

const messageCount = (sql: SqlClient.SqlClient, memoryId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      total: number
    }>`SELECT COUNT(*) AS total FROM optchat_messages WHERE memory_id = ${memoryId}`
    return rows[0]?.total ?? 0
  })

const sessionV1 = [
  header('sess-growth'),
  userEntry('g1', null, 'first', ts(0)),
  userEntry('g2', 'g1', 'second', ts(1)),
  userEntry('g3', 'g2', 'third', ts(2)),
].join('\n')
const sessionV2 = [
  header('sess-growth'),
  userEntry('g1', null, 'first', ts(0)),
  userEntry('g2', 'g1', 'second', ts(1)),
  userEntry('g3', 'g2', 'third', ts(2)),
  userEntry('g4', 'g3', 'fourth', ts(3)),
  userEntry('g5', 'g4', 'fifth', ts(4)),
].join('\n')

test('reimports deduplicate and growing sessions append only new entries', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { sql, memory } = yield* setupBinding('chan-growth')
      const first = yield* mapPiSessionContent(sessionV1)
      const outcome1 = yield* importMappedInputs(
        memory,
        'chan-growth',
        first.sessionId,
        first.inputs,
        false,
      )
      expect(outcome1).toMatchObject({ total: 3, imported: 3, skipped: 0, dryRun: false })
      expect(yield* messageCount(sql, 'chan-growth')).toBe(3)
      const before = yield* memory.zoom('chan-growth', 0, 1)

      const replay = yield* mapPiSessionContent(sessionV1)
      const outcome2 = yield* importMappedInputs(
        memory,
        'chan-growth',
        replay.sessionId,
        replay.inputs,
        false,
      )
      expect(outcome2).toMatchObject({ total: 3, imported: 0, skipped: 3 })
      expect(yield* messageCount(sql, 'chan-growth')).toBe(3)
      expect(yield* memory.zoom('chan-growth', 0, 1)).toBe(before)

      const grown = yield* mapPiSessionContent(sessionV2)
      const outcome3 = yield* importMappedInputs(
        memory,
        'chan-growth',
        grown.sessionId,
        grown.inputs,
        false,
      )
      expect(outcome3).toMatchObject({ total: 5, imported: 2, skipped: 3 })
      expect(yield* messageCount(sql, 'chan-growth')).toBe(5)
      expect(yield* memory.zoom('chan-growth', 0, 1)).toBe(before)
      expect(yield* memory.zoom('chan-growth', 4, 1)).toContain('fifth')
    }).pipe(
      Effect.provide(OptChatConfigurationLive),
      Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
    ),
  ))

test('invalid files write nothing', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { sql, memory } = yield* setupBinding('chan-atomic')
      const valid = yield* mapPiSessionContent(sessionV1)
      yield* importMappedInputs(memory, 'chan-atomic', valid.sessionId, valid.inputs, false)
      expect(yield* messageCount(sql, 'chan-atomic')).toBe(3)
      const before = yield* memory.zoom('chan-atomic', 1, 1)

      const badContents = [
        '',
        userEntry('x1', null, 'no header', ts(0)),
        [header('sess-bad'), '{not json'].join('\n'),
        [header('sess-bad'), userEntry('x1', null, 'ok', ts(0)), header('sess-other')].join('\n'),
      ]
      for (const bad of badContents) {
        const exit = yield* Effect.exit(mapPiSessionContent(bad))
        expect(exit._tag).toBe('Failure')
      }
      // A mapping failure leaves the transaction untouched: no partial rows.
      expect(yield* messageCount(sql, 'chan-atomic')).toBe(3)
      expect(yield* memory.zoom('chan-atomic', 1, 1)).toBe(before)
    }).pipe(
      Effect.provide(OptChatConfigurationLive),
      Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
    ),
  ))

test('dry-run reports counts without database mutations', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { sql, memory } = yield* setupBinding('chan-dry')
      const mapped = yield* mapPiSessionContent(sessionV2)
      const outcome = yield* importMappedInputs(
        memory,
        'chan-dry',
        mapped.sessionId,
        mapped.inputs,
        true,
      )
      expect(outcome).toMatchObject({ total: 5, imported: 5, skipped: 0, dryRun: true })
      expect(yield* messageCount(sql, 'chan-dry')).toBe(0)

      const applied = yield* importMappedInputs(
        memory,
        'chan-dry',
        mapped.sessionId,
        mapped.inputs,
        false,
      )
      expect(applied).toMatchObject({ total: 5, imported: 5, skipped: 0, dryRun: false })
      const preview = yield* importMappedInputs(
        memory,
        'chan-dry',
        mapped.sessionId,
        mapped.inputs,
        true,
      )
      expect(preview).toMatchObject({ total: 5, imported: 0, skipped: 5, dryRun: true })
      expect(yield* messageCount(sql, 'chan-dry')).toBe(5)
    }).pipe(
      Effect.provide(OptChatConfigurationLive),
      Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
    ),
  ))

test('isolates memories and sessions by stable identity', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { sql, memory } = yield* setupBinding('chan-a')
      yield* setupBinding('chan-b')
      const sessionA = [header('sess-A'), userEntry('shared-id', null, 'from A', ts(0))].join('\n')
      const sessionB = [header('sess-B'), userEntry('shared-id', null, 'from B', ts(0))].join('\n')
      const mappedA = yield* mapPiSessionContent(sessionA)
      const mappedB = yield* mapPiSessionContent(sessionB)
      // Same entry id in different sessions must not collide in one memory.
      yield* importMappedInputs(memory, 'chan-a', mappedA.sessionId, mappedA.inputs, false)
      const outcomeB = yield* importMappedInputs(
        memory,
        'chan-a',
        mappedB.sessionId,
        mappedB.inputs,
        false,
      )
      expect(outcomeB).toMatchObject({ total: 1, imported: 1, skipped: 0 })
      expect(yield* messageCount(sql, 'chan-a')).toBe(2)
      // Same session in another memory stays isolated by memory id.
      yield* importMappedInputs(memory, 'chan-b', mappedA.sessionId, mappedA.inputs, false)
      expect(yield* messageCount(sql, 'chan-b')).toBe(1)
      expect(yield* memory.zoom('chan-b', 0, 1)).toContain('from A')
    }).pipe(
      Effect.provide(OptChatConfigurationLive),
      Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
    ),
  ))

test('existing message ids do not shift after import', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { memory } = yield* setupBinding('chan-stable')
      yield* memory.append('chan-stable', [
        {
          sourceKey: 'manual:0',
          kind: 'user',
          text: 'manual first',
          date: '2026-10-05T00:00:00.000Z',
        },
        {
          sourceKey: 'manual:1',
          kind: 'talk',
          text: 'manual second',
          date: '2026-10-05T00:01:00.000Z',
        },
      ])
      const firstBefore = yield* memory.zoom('chan-stable', 0, 1)
      const secondBefore = yield* memory.zoom('chan-stable', 1, 1)
      const mapped = yield* mapPiSessionContent(sessionV1)
      yield* importMappedInputs(memory, 'chan-stable', mapped.sessionId, mapped.inputs, false)
      expect(yield* memory.zoom('chan-stable', 0, 1)).toBe(firstBefore)
      expect(yield* memory.zoom('chan-stable', 1, 1)).toBe(secondBefore)
      expect(yield* memory.zoom('chan-stable', 2, 1)).toContain('first')
    }).pipe(
      Effect.provide(OptChatConfigurationLive),
      Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
    ),
  ))
