/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/strict-effect-provide -- Bun runs SQLite integration tests; Effect execution is the explicit test boundary. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'

import {
  DefaultIdentityText,
  IdentityConfiguration,
  IdentityConfigurationLive,
  IdentityText,
} from './IdentityConfiguration.ts'

const database = SqliteClient.layer({ filename: ':memory:' })
const decodeIdentityText = Schema.decodeSync(IdentityText)

test('defaults to the exact Friday identity text', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* IdentityConfiguration
      assert.strictEqual(yield* identity.get(), 'Your name is Friday')
      assert.strictEqual(yield* identity.get(), DefaultIdentityText)
    }).pipe(Effect.provide(IdentityConfigurationLive.pipe(Layer.provide(database)))),
  ))

test('stores custom identity text literally without interpolation', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* IdentityConfiguration
      const custom = decodeIdentityText(
        'Use this exact text.\nDo not interpolate {{channelName}} or {{rootUsers}}.',
      )
      assert.strictEqual(yield* identity.set(custom), 'updated')
      assert.strictEqual(yield* identity.get(), custom)
      assert.strictEqual(yield* identity.set(custom), 'unchanged')
      const revised = decodeIdentityText('Your name is Friday')
      assert.strictEqual(yield* identity.set(revised), 'updated')
      assert.strictEqual(yield* identity.get(), revised)
    }).pipe(Effect.provide(IdentityConfigurationLive.pipe(Layer.provide(database)))),
  ))

test('initializes the database tables without a prior Friday start', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const identity = yield* IdentityConfiguration
      assert.strictEqual(yield* identity.get(), 'Your name is Friday')
    }).pipe(Effect.provide(IdentityConfigurationLive.pipe(Layer.provide(database)))),
  ))
