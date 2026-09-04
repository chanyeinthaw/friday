import { assert, it } from '@effect/vitest'
import { ModelSelection } from '@friday/contracts/conversation'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { PiModelRuntime } from './Live.ts'
import { makePiTextGeneration } from './PiTextGeneration.ts'

const decodeModelSelection = Schema.decodeSync(ModelSelection)

it.effect('refreshes shared Pi model state before resolving the title model', () =>
  Effect.gen(function* () {
    const runtime = yield* Effect.promise(() => ModelRuntime.create({ allowModelNetwork: false }))
    const order: Array<string> = []
    const seen: Array<unknown> = []
    const originalRefresh = runtime.refresh.bind(runtime)
    const originalGetModel = runtime.getModel.bind(runtime)
    runtime.refresh = (options) => {
      order.push('refresh')
      seen.push(options)
      return originalRefresh(options)
    }
    runtime.getModel = (providerId, modelId) => {
      order.push('getModel')
      return originalGetModel(providerId, modelId)
    }
    const textGeneration = yield* makePiTextGeneration().pipe(
      Effect.provideService(PiModelRuntime, runtime),
    )
    // A missing model short-circuits before session creation, so this covers
    // refresh ordering without creating a session or touching the network.
    const error = yield* textGeneration
      .generateThreadTitle({
        message: 'hello world',
        workingDirectory: '/tmp/friday-title-refresh',
        model: decodeModelSelection({ provider: 'missing-provider', modelId: 'missing-model' }),
        thinkingLevel: 'max',
      })
      .pipe(Effect.flip)
    assert.deepStrictEqual(seen, [{ allowNetwork: false }])
    assert.deepStrictEqual(order, ['refresh', 'getModel'])
    assert.strictEqual(error.operation, 'thread-title')
  }),
)
