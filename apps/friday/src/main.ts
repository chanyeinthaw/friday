/* oxlint-disable effecttsgo/strict-effect-provide -- This executable is the application entry point and provides the complete live layer once. */

import { BunRuntime } from '@effect/platform-bun'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'

import { FridayLive, makeFridayApplicationLive } from './Live.ts'

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* makeFridayApplicationLive()
    yield* Console.log('Friday is ready.')
  }),
).pipe(Effect.provide(FridayLive))

BunRuntime.runMain(program)
