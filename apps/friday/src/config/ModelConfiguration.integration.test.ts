/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/strict-effect-provide, effecttsgo/node-builtin-import -- Bun runs the SQLite boundary against temporary database files. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import {
  ModelId,
  ProviderId,
  SubagentProfileName,
  ThinkingLevel,
} from '@friday/contracts/conversation'

import { ModelConfiguration, ModelConfigurationLive } from './ModelConfiguration.ts'

const decodeProvider = Schema.decodeSync(ProviderId)
const decodeModel = Schema.decodeSync(ModelId)
const decodeName = Schema.decodeSync(SubagentProfileName)
const decodeThinking = Schema.decodeSync(ThinkingLevel)
const database = SqliteClient.layer({ filename: ':memory:' })
const live = ModelConfigurationLive.pipe(Layer.provide(database))

test('stores fixed selections and profiles with stable ordering and typed outcomes', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* ModelConfiguration
      assert.deepStrictEqual(
        (yield* config.listModels()).map((model) => model.name),
        ['primary', 'utility'],
      )
      const selection = {
        name: 'primary' as const,
        provider: decodeProvider('missing-provider'),
        modelId: decodeModel('missing-model'),
        thinkingLevel: decodeThinking('high'),
      }
      assert.strictEqual(yield* config.setModel(selection), 'updated')
      assert.strictEqual(yield* config.setModel(selection), 'unchanged')
      assert.deepStrictEqual(yield* config.getModel('primary'), selection)

      const zeta = {
        name: decodeName('zeta'),
        description: 'Zeta work',
        provider: decodeProvider('provider-z'),
        modelId: decodeModel('model-z'),
        thinkingLevel: decodeThinking('low'),
      }
      const alpha = {
        name: decodeName('alpha'),
        description: 'Alpha work',
        provider: decodeProvider('provider-a'),
        modelId: decodeModel('model-a'),
        thinkingLevel: decodeThinking('medium'),
      }
      assert.strictEqual(yield* config.addProfile(zeta), 'added')
      assert.strictEqual(yield* config.addProfile(zeta), 'exists')
      assert.strictEqual(yield* config.addProfile(alpha), 'added')
      assert.deepStrictEqual(
        (yield* config.listProfiles()).map((profile) => profile.name),
        ['alpha', 'primary', 'zeta'],
      )
      assert.strictEqual(
        yield* config.updateProfile({ name: alpha.name, description: 'Alpha revised' }),
        'updated',
      )
      assert.strictEqual(
        yield* config.updateProfile({ name: alpha.name, description: 'Alpha revised' }),
        'unchanged',
      )
      assert.strictEqual(
        yield* config.updateProfile({ name: decodeName('missing'), description: 'Missing' }),
        'missing',
      )
      assert.strictEqual(yield* config.removeProfile(decodeName('primary')), 'protected')
      assert.strictEqual(yield* config.removeProfile(alpha.name), 'removed')
      assert.strictEqual(yield* config.removeProfile(alpha.name), 'missing')
    }).pipe(Effect.provide(live)),
  ))

test('reports migration failures as typed model configuration errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-model-config-'))
  const filename = join(directory, 'config.sqlite')
  const fileDatabase = SqliteClient.layer({ filename })
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient
      yield* sql`CREATE TABLE agent_config (id INTEGER PRIMARY KEY)`
    }).pipe(Effect.provide(fileDatabase)),
  )

  const error = await Effect.runPromise(
    ModelConfiguration.pipe(
      Effect.provide(ModelConfigurationLive.pipe(Layer.provide(fileDatabase))),
      Effect.flip,
    ),
  )
  assert.strictEqual(error.operation, 'migrate')
  assert.match(error.message, /Model configuration migrate failed/)
})

test('rejects malformed persisted rows during typed row decoding', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* ModelConfiguration
      const sql = yield* SqliteClient.SqliteClient
      yield* sql`UPDATE agent_config SET primary_thinking_level = 'impossible' WHERE id = 1`
      const error = yield* Effect.flip(config.listModels())
      assert.strictEqual(error.operation, 'decode')
    }).pipe(Effect.provide(Layer.merge(live, database))),
  ))
