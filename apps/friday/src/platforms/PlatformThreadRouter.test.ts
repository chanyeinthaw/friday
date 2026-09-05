/* oxlint-disable eslint/no-underscore-dangle -- Effect schema errors use the canonical _tag discriminator. */
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { decodeThreadRouteDecision, PlatformThreadRouterError } from './PlatformThreadRouter.ts'

it.effect('accepts the conservative keep decision', () =>
  Effect.gen(function* () {
    const decision = yield* decodeThreadRouteDecision({
      decision: 'keep-channel',
      reason: 'channel-appropriate',
    })
    assert.deepStrictEqual(decision, {
      decision: 'keep-channel',
      reason: 'channel-appropriate',
    })
  }),
)

it.effect('accepts explicit and beneficial thread decisions', () =>
  Effect.gen(function* () {
    const explicit = yield* decodeThreadRouteDecision({
      decision: 'create-thread',
      reason: 'explicit-request',
    })
    const beneficial = yield* decodeThreadRouteDecision({
      decision: 'create-thread',
      reason: 'thread-beneficial',
    })
    assert.deepStrictEqual(explicit, {
      decision: 'create-thread',
      reason: 'explicit-request',
    })
    assert.deepStrictEqual(beneficial, {
      decision: 'create-thread',
      reason: 'thread-beneficial',
    })
  }),
)

it.effect('rejects mismatched decision and reason pairs', () =>
  Effect.gen(function* () {
    const mismatched = yield* decodeThreadRouteDecision({
      decision: 'keep-channel',
      reason: 'explicit-request',
    }).pipe(Effect.flip)
    assert.isDefined(mismatched)

    const permissiveKeep = yield* decodeThreadRouteDecision({
      decision: 'create-thread',
      reason: 'channel-appropriate',
    }).pipe(Effect.flip)
    assert.isDefined(permissiveKeep)
  }),
)

it('reports routing failures with the thread-route operation', () => {
  const error = new PlatformThreadRouterError({
    operation: 'thread-route',
    detail: 'Routing decision timed out.',
  })
  assert.strictEqual(error.operation, 'thread-route')
  assert.strictEqual(error.detail, 'Routing decision timed out.')
  assert.strictEqual(error._tag, 'PlatformThreadRouterError')
})
