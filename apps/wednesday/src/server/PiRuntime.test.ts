import { it } from '@effect/vitest'
import { expect } from 'vitest'
import { Cause, Deferred, Effect, Exit, Fiber, Redacted } from 'effect'
import { AgentRuntime } from './AgentRuntime.ts'
import { piRuntimeLayer } from './PiRuntime.ts'
import { defaultMapping } from './Providers.ts'

it.effect('cancels a Pi session while memory is waiting for the active chat turn', () => {
  const mapping = defaultMapping('gpt-6.1-sol', 'responses')
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const runtime = yield* AgentRuntime
    const session = yield* runtime.open({
      connection: {
        userId: 'test-memory-cancellation',
        purpose: 'memory',
        cacheKey: 'test-memory-cancellation:memory',
        settings: {
          provider: 'api',
          apiFormat: 'responses',
          baseUrl: 'http://127.0.0.1:1/v1',
          modelId: mapping.id,
          thinking: 'off',
          models: [mapping],
        },
        mapping,
        thinking: 'off',
        credential: Effect.succeed({ apiKey: Redacted.make('test-key') }),
      },
      systemPrompt: 'Summarize the supplied message.',
      view: '<chat>\n</chat>',
      memory: { zoom: () => Effect.succeed(''), date: () => Effect.succeed('') },
      beforeRequest: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    })
    const fiber = yield* session.send('Compaction: summarize this message.').pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
  }).pipe(Effect.scoped, Effect.provide(piRuntimeLayer))
})
