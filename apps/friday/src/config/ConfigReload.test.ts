import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { AppConfigError } from './AppConfig.ts'
import {
  ConfigReloadOutcome,
  formatConfigReloadOutcome,
  reloadApplicationConfig,
  reloadFailed,
  reloadSucceeded,
  reloadUnauthorized,
} from './ConfigReload.ts'

const isOutcome = Schema.is(ConfigReloadOutcome)

it.effect('maps a successful reload to a success outcome', () =>
  Effect.gen(function* () {
    const outcome = yield* reloadApplicationConfig({
      reload: Effect.succeed(7),
    })
    assert.deepStrictEqual(outcome, reloadSucceeded(7))
    assert(isOutcome(outcome))
  }),
)

it.effect('maps a failed reload to a reload-failed outcome instead of failing', () =>
  Effect.gen(function* () {
    const outcome = yield* reloadApplicationConfig({
      reload: Effect.fail(
        new AppConfigError({ operation: 'read', path: 'agent_config', detail: 'broken' }),
      ),
    })
    assert.deepStrictEqual(outcome, reloadFailed('broken'))
    assert(isOutcome(outcome))
  }),
)

it('encodes and decodes outcomes through the shared schema', () => {
  const encode = Schema.encodeSync(ConfigReloadOutcome)
  const decode = Schema.decodeUnknownSync(ConfigReloadOutcome)
  const success = decode(encode(reloadSucceeded(3)))
  const failure = decode(encode(reloadUnauthorized('not allowed')))
  assert.deepStrictEqual(success, { ok: true, version: 3 })
  assert.deepStrictEqual(failure, {
    ok: false,
    reason: 'unauthorized',
    detail: 'not allowed',
  })
  assert.throws(() => decode({ ok: 'maybe' }))
})

it('formats outcomes for display', () => {
  assert.strictEqual(
    formatConfigReloadOutcome(reloadSucceeded(5)),
    'Configuration reloaded (version 5).',
  )
  assert.strictEqual(
    formatConfigReloadOutcome(reloadFailed('Stored Friday configuration is invalid.')),
    'Configuration reload failed (reload-failed): Stored Friday configuration is invalid.',
  )
})
