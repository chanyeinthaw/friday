import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { getPiModel, listPiModels, reloadPiModels } from './PiModelCatalog.ts'

it.effect('lists stable redacted catalog records and reports missing entries', () =>
  Effect.gen(function* () {
    const models = yield* listPiModels()
    assert.ok(models.length > 0)
    assert.deepStrictEqual(
      models,
      [...models].toSorted(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId),
      ),
    )
    assert.ok(
      models.every(
        (model) => !('apiKey' in model) && !('headers' in model) && !('baseUrl' in model),
      ),
    )
    assert.strictEqual(yield* getPiModel('provider-that-does-not-exist', 'missing'), undefined)
  }),
)

it.effect('reloads the local Pi catalog with network disabled', () =>
  reloadPiModels().pipe(
    Effect.map((count) => {
      assert.ok(count > 0)
    }),
  ),
)
