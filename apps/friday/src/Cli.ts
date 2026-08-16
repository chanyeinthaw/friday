import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export const FRIDAY_VERSION = '0.1.0'

export const helpText = `Friday — your personal agent

Usage:
  friday [command]

Commands:
  start       Start Friday (default)

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`

export type FridayCliAction = 'help' | 'start' | 'version'

export class FridayCliError extends Schema.Error<FridayCliError>('FridayCliError')({
  _tag: Schema.tag('FridayCliError'),
  argument: Schema.String,
}) {
  override get message(): string {
    return `Unknown Friday command or option: ${this.argument}`
  }
}

export const parseFridayCli = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<FridayCliAction, FridayCliError> => {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === 'start')) {
    return Effect.succeed('start')
  }
  if (arguments_.length === 1 && (arguments_[0] === '--help' || arguments_[0] === '-h')) {
    return Effect.succeed('help')
  }
  if (arguments_.length === 1 && (arguments_[0] === '--version' || arguments_[0] === '-v')) {
    return Effect.succeed('version')
  }
  return Effect.fail(new FridayCliError({ argument: arguments_.join(' ') }))
}

export const runFridayCli = <E, R>(
  arguments_: ReadonlyArray<string>,
  start: Effect.Effect<never, E, R>,
): Effect.Effect<void, FridayCliError | E, R> =>
  parseFridayCli(arguments_).pipe(
    Effect.flatMap((action) =>
      action === 'help'
        ? Console.log(helpText.trimEnd())
        : action === 'version'
          ? Console.log(FRIDAY_VERSION)
          : start,
    ),
  )
