/* oxlint-disable effecttsgo/strict-effect-provide -- This executable is the application entry point and provides the complete live layer once. */

import { BunRuntime } from '@effect/platform-bun'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'

import { FridayLive } from './Live.ts'
import { startDiscord } from './surfaces/discord/DiscordLive.ts'
import { FridaySqliteLive } from './persistence/Live.ts'

const program = Effect.scoped(
  Effect.gen(function* () {
    yield* startDiscord().pipe(Effect.provide(FridaySqliteLive))
    yield* Console.log('Friday is ready.')
    return yield* Effect.never
  }),
).pipe(Effect.provide(FridayLive))

BunRuntime.runMain(program)
