import { assert, it } from '@effect/vitest'
import { ModelSelection } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { makeTaskModels } from './TaskModels.ts'

const decodeModel = Schema.decodeSync(ModelSelection)
const fast = decodeModel({ provider: 'opencode-go', modelId: 'deepseek-v4-flash' })
const deep = decodeModel({ provider: 'anthropic', modelId: 'claude-opus' })

it.effect('resolves only configured task models and exposes the first as default', () =>
  Effect.gen(function* () {
    const models = makeTaskModels([fast, deep])

    assert.deepStrictEqual(Option.getOrNull(yield* models.defaultModel), fast)
    assert.deepStrictEqual(Option.getOrNull(yield* models.resolve(deep)), deep)
    assert(
      Option.isNone(yield* models.resolve(decodeModel({ provider: 'openai', modelId: 'gpt-5' }))),
    )
  }),
)

it.effect('has no default when no task models are configured', () =>
  Effect.gen(function* () {
    const models = makeTaskModels([])

    assert(Option.isNone(yield* models.defaultModel))
  }),
)
