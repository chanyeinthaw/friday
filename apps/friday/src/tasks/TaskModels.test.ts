import { assert, it } from '@effect/vitest'
import { SubagentProfileName } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { SubagentProfile } from '../config/AppConfig.ts'
import { makeTaskModels } from './TaskModels.ts'

const decodeProfile = Schema.decodeSync(SubagentProfile)
const decodeProfileName = Schema.decodeSync(SubagentProfileName)
const primary = decodeProfile({
  name: 'primary',
  description: 'General delegated work.',
  model: { provider: 'opencode-go', modelId: 'glm-5.3-flash' },
  thinkingLevel: 'max',
})
const review = decodeProfile({
  name: 'review',
  description: 'Focused code review.',
  model: { provider: 'anthropic', modelId: 'claude-opus' },
  thinkingLevel: 'high',
})

it.effect("resolves configured profiles and exposes 'primary' as default", () =>
  Effect.gen(function* () {
    const models = makeTaskModels([review, primary])

    assert.deepStrictEqual(Option.getOrNull(yield* models.defaultProfile), primary)
    assert.deepStrictEqual(
      Option.getOrNull(yield* models.resolve(decodeProfileName('review'))),
      review,
    )
    assert(Option.isNone(yield* models.resolve(decodeProfileName('missing'))))
  }),
)

it.effect("has no default without a 'primary' profile", () =>
  Effect.gen(function* () {
    const models = makeTaskModels([review])

    assert(Option.isNone(yield* models.defaultProfile))
  }),
)
