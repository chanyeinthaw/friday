/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide -- Tests execute the real Pi-durable utility harness with an in-memory provider. */
import { expect, test } from 'bun:test'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import * as Effect from 'effect/Effect'
import type * as Duration from 'effect/Duration'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'

import { AppConfig as ConfigSchema } from '../../config/AppConfig.ts'
import { AppConfig } from '../../config/AppConfigLive.ts'
import { makePiPlatformThreadRouter } from './PiPlatformThreadRouter.ts'

const config = Schema.decodeUnknownSync(ConfigSchema)({
  installationId: 'test',
  models: {
    primary: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' },
    utility: { provider: 'faux', modelId: 'faux-1', thinkingLevel: 'off' },
    subagents: [],
  },
  platforms: { discord: [], slack: [] },
  agent: { recentMessageCount: 20 },
  admin: { discordUserIds: [] },
})
const setup = (timeout: Duration.Input = '1 second') => {
  const faux = fauxProvider({ tokensPerSecond: Infinity })
  const models = createModels()
  models.setProvider(faux.provider)
  const router = makePiPlatformThreadRouter({
    models,
    operationTimeout: timeout,
    workingDirectory: '/tmp',
  }).pipe(Effect.provideService(AppConfig, { current: () => config, reload: Effect.succeed(1) }))
  return { faux, router }
}

test('records a validated route through a native terminating tool', async () => {
  const f = setup()
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('thread_route', { decision: 'create-thread', reason: 'explicit-request' }),
      { stopReason: 'toolUse' },
    ),
  ])
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const router = yield* f.router
      return yield* router.decide({ text: 'Create a thread for this task.', context: [] })
    }),
  )
  expect(result).toEqual({ decision: 'create-thread', reason: 'explicit-request' })
  expect(f.faux.state.callCount).toBe(1)
})

test('fails when the model answers without the routing tool', async () => {
  const f = setup()
  f.faux.setResponses([fauxAssistantMessage('Use a thread.')])
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const router = yield* f.router
      return yield* Effect.exit(router.decide({ text: 'Inspect this project.', context: [] }))
    }),
  )
  expect(Exit.isFailure(result)).toBe(true)
  expect(f.faux.state.callCount).toBe(1)
})

test('cancels a utility generation when its deadline expires', async () => {
  const f = setup('10 millis')
  f.faux.setResponses([
    async (_context, options) => {
      await Effect.runPromise(Effect.never, { signal: options?.signal })
      return fauxAssistantMessage('unreachable')
    },
  ])
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const router = yield* f.router
      return yield* Effect.exit(router.decide({ text: 'Inspect this project.', context: [] }))
    }),
  )
  expect(Exit.isFailure(result)).toBe(true)
})
