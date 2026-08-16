import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { FridayCliError, parseFridayCli } from './Cli.ts'

const isFridayCliError = Schema.is(FridayCliError)

it.effect('uses start as the default command', () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* parseFridayCli([]), 'start')
    assert.strictEqual(yield* parseFridayCli(['start']), 'start')
  }),
)

it.effect('recognizes help without starting Friday', () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* parseFridayCli(['--help']), 'help')
    assert.strictEqual(yield* parseFridayCli(['-h']), 'help')
  }),
)

it.effect('recognizes version without starting Friday', () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* parseFridayCli(['--version']), 'version')
    assert.strictEqual(yield* parseFridayCli(['-v']), 'version')
  }),
)

it.effect('rejects unknown commands', () =>
  Effect.gen(function* () {
    const exit = yield* parseFridayCli(['wat']).pipe(Effect.exit)
    assert(Exit.isFailure(exit))
    const error = Exit.findErrorOption(exit)
    assert(Option.isSome(error))
    assert(isFridayCliError(error.value))
    assert.strictEqual(error.value.argument, 'wat')
  }),
)
