/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/strict-effect-provide, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- The injected Pi factory is a Promise SDK boundary; tests also inspect a real Pi session at the installed SDK boundary. */

import { assert, it } from '@effect/vitest'
import { ModelSelection } from '@friday/contracts/conversation'
import { DefaultResourceLoader, ModelRuntime } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Layer from 'effect/Layer'

import { PiModelRuntime } from './Live.ts'
import {
  LinkedHandoffSystemPrompt,
  makeIsolatedLinkedHandoffAgent,
  makePiTextGeneration,
} from './PiTextGeneration.ts'

const decodeModel = Schema.decodeSync(ModelSelection)

it.effect('runs linked handoff transformation in an isolated no-tools utility session', () =>
  Effect.gen(function* () {
    let prompted = ''
    let disposed = 0
    const messages: Array<{
      readonly role: string
      readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
    }> = []
    const service = yield* makePiTextGeneration({
      createLinkedAgent: () => ({
        state: { messages },
        prompt: async (prompt) => {
          prompted = prompt
          messages.push({
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: '{"title":"Login failure","prompt":"Investigate login failure."}',
              },
            ],
          })
        },
        abort: () => {
          disposed++
        },
      }),
    })

    const result = yield* service.generateLinkedHandoff({
      sourceMaterial: '[TRIGGER] 2026-01-01T00:00:00.000Z P1: investigate login failure',
      model: decodeModel({ provider: 'utility', modelId: 'small' }),
      thinkingLevel: 'low',
    })

    assert.deepStrictEqual(result, { title: 'Login failure', prompt: 'Investigate login failure.' })
    assert.include(prompted, '<untrusted-discord-source>')
    assert.notInclude(prompted, 'Produce JSON with exactly two string fields')
    assert.strictEqual(disposed, 1)
  }).pipe(
    Effect.provide(
      Layer.succeed(PiModelRuntime, {
        getModel: () => ({ provider: 'utility', id: 'small' }),
        getAuth: async () => ({ type: 'api_key', key: 'test' }),
      } as never),
    ),
  ),
)

it.effect('uses the installed lower-level Pi Agent with no resource loader or Friday prompt', () =>
  Effect.gen(function* () {
    const modelRuntime = yield* Effect.promise(() =>
      ModelRuntime.create({ allowModelNetwork: false }),
    )
    const agent = makeIsolatedLinkedHandoffAgent({
      model: { provider: 'test', id: 'utility' } as never,
      thinkingLevel: 'low',
      modelRuntime,
    })

    assert.isFalse('resourceLoader' in agent)
    assert.isFalse(agent instanceof DefaultResourceLoader)
    assert.deepStrictEqual(agent.state.tools, [])
    assert.strictEqual(agent.state.systemPrompt, LinkedHandoffSystemPrompt)
    assert.notInclude(agent.state.systemPrompt, 'expert coding assistant')
    assert.notInclude(agent.state.systemPrompt, 'Project-specific instructions')
    assert.notInclude(agent.state.systemPrompt, 'Available tools:')
    agent.abort()
  }),
)
