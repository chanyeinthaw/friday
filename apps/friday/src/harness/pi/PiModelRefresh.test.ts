import { assert, it } from '@effect/vitest'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'

import { TextGenerationError } from '../TextGeneration.ts'
import { PiThreadRuntimeError } from './PiThreadRuntime.ts'
import { refreshSharedModelRuntime } from './PiModelRefresh.ts'

it.effect('refreshes local Pi model state without network access', () =>
  Effect.gen(function* () {
    const seen: Array<unknown> = []
    const runtime: Pick<ModelRuntime, 'refresh'> = {
      refresh: (options) => {
        seen.push(options)
        return Promise.resolve({ aborted: false, errors: new Map() })
      },
    }
    yield* refreshSharedModelRuntime(
      runtime,
      (input) => new PiThreadRuntimeError({ operation: 'resolve-model', ...input }),
    )
    assert.deepStrictEqual(seen, [{ allowNetwork: false }])
  }),
)

it.effect('maps refresh rejection to the caller typed error', () =>
  Effect.gen(function* () {
    const failure = new Error('disk boom')
    const runtime: Pick<ModelRuntime, 'refresh'> = {
      refresh: () => Promise.reject(failure),
    }
    const error = yield* refreshSharedModelRuntime(
      runtime,
      (input) => new PiThreadRuntimeError({ operation: 'resolve-model', ...input }),
    ).pipe(Effect.flip)
    assert.strictEqual(error.operation, 'resolve-model')
    assert.strictEqual(error.detail, 'Failed to refresh Pi model state: disk boom')
    assert.strictEqual(error.cause, failure)
  }),
)

it.effect('preserves provider errors as an AggregateError cause', () =>
  Effect.gen(function* () {
    const first = new Error('bad-a')
    const second = new Error('bad-b')
    const runtime: Pick<ModelRuntime, 'refresh'> = {
      refresh: () =>
        Promise.resolve({
          aborted: false,
          errors: new Map([
            ['prov-a', first],
            ['prov-b', second],
          ]),
        }),
    }
    const error = yield* refreshSharedModelRuntime(
      runtime,
      (input) => new PiThreadRuntimeError({ operation: 'resolve-model', ...input }),
    ).pipe(Effect.flip)
    assert.strictEqual(error.detail, 'prov-a: bad-a; prov-b: bad-b')
    assert.instanceOf(error.cause, AggregateError)
    if (error.cause instanceof AggregateError) {
      assert.deepStrictEqual([...error.cause.errors], [first, second])
    }
  }),
)

it.effect('maps aborted refresh to the title-generation typed error', () =>
  Effect.gen(function* () {
    const runtime: Pick<ModelRuntime, 'refresh'> = {
      refresh: () => Promise.resolve({ aborted: true, errors: new Map() }),
    }
    const error = yield* refreshSharedModelRuntime(
      runtime,
      (input) => new TextGenerationError({ operation: 'thread-title', ...input }),
    ).pipe(Effect.flip)
    assert.strictEqual(error.operation, 'thread-title')
    assert.strictEqual(error.detail, 'Pi model refresh was aborted before resolving the model.')
  }),
)
