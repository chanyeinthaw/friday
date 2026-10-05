/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests -- Tests exercise callbacks invoked outside the Effect runtime by the Pi SDK. */
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { expect, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Ref from 'effect/Ref'

import { makePiRunner, runPiEffect } from './index.ts'

class Greeting extends Context.Service<Greeting, { readonly text: string }>()('test/Greeting') {}

it.effect('captures services for callbacks invoked after construction', () =>
  Effect.gen(function* () {
    const run = yield* makePiRunner<Greeting>().pipe(
      Effect.provideService(Greeting, { text: 'captured' }),
    )
    const result = yield* Effect.promise(() =>
      run(
        Effect.map(Greeting, (greeting) => greeting.text),
        BACKGROUND_CONTEXT,
      ),
    )
    expect(result).toBe('captured')
  }),
)

it.effect('Pi cancellation interrupts the callback and runs its finalizers', () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const finalized = yield* Ref.make(false)
    const controller = new AbortController()
    const invocation = runPiEffect(
      Effect.gen(function* () {
        yield* Deferred.succeed(ready, undefined)
        return yield* Effect.never
      }).pipe(Effect.ensuring(Ref.set(finalized, true))),
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
    // Observe rejection immediately so interruption cannot cause an unhandled rejection.
    const observed = Effect.runPromiseExit(Effect.tryPromise(() => invocation))
    yield* Deferred.await(ready)
    controller.abort()
    const exit = yield* Effect.promise(() => observed)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* Ref.get(finalized)).toBe(true)
  }),
)
