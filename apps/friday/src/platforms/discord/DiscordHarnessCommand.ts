import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import {
  formatHarnessReloadOutcome,
  type HarnessReloadOutcome,
} from '../../conversation/ThreadRuntime.ts'

export const HARNESS_COMMAND_NAME = 'harness'
export const HARNESS_RELOAD_SUBCOMMAND = 'reload'

/**
 * Full Chat SDK command path the Discord adapter produces when the reload
 * subcommand carries leaf arguments (the adapter appends subcommand names to
 * the command path, e.g. "/project issue create").
 */
export const HARNESS_COMMAND_PATH = `/${HARNESS_COMMAND_NAME} ${HARNESS_RELOAD_SUBCOMMAND}`

/**
 * Command paths the Discord adapter produces for `/harness reload` events.
 * As with `/friday reload`, the adapter only appends a subcommand name when
 * that subcommand carries leaf options — `reload` takes none, so real
 * invocations keep the parent-only "/harness" path.
 */
export const HARNESS_COMMAND_PATHS = [`/${HARNESS_COMMAND_NAME}`, HARNESS_COMMAND_PATH]

/**
 * Decision for one `/harness` application command interaction. The Discord
 * transport applies the decision. Unlike `/friday reload`, there is no
 * authorization guard: any user in a resolvable thread may reload.
 */
export type HarnessCommandDecision =
  | { readonly kind: 'reload' }
  | { readonly kind: 'usage'; readonly detail: string }

/** Parses the raw adapter interaction payload; run this at the transport boundary. */
export const decodeHarnessInteraction = Schema.decodeUnknownOption(
  Schema.Struct({
    data: Schema.optionalKey(
      Schema.Struct({
        options: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      }),
    ),
  }),
)

/**
 * Extracts the invoked `/harness` subcommand from the raw adapter interaction
 * payload. Gateway interactions normalize the subcommand into `data.options`.
 */
export const harnessSubcommand = (interaction: {
  readonly data?: { readonly options?: ReadonlyArray<{ name: string }> }
}): Option.Option<string> => Option.fromNullishOr(interaction.data?.options?.[0]?.name)

/**
 * Pure decision for a `/harness` interaction. Only the `reload` subcommand is
 * recognized; any other subcommand receives guidance. The `reload` decision is
 * unconditional — authorization is intentionally absent for this command.
 */
export const decideHarnessCommand = (input: {
  readonly subcommand: Option.Option<string>
}): HarnessCommandDecision =>
  input.subcommand._tag === 'Some' && input.subcommand.value === HARNESS_RELOAD_SUBCOMMAND
    ? { kind: 'reload' }
    : {
        kind: 'usage',
        detail: `Usage: /${HARNESS_COMMAND_NAME} ${HARNESS_RELOAD_SUBCOMMAND}`,
      }

export const harnessCommandReply = (decision: { readonly detail: string }): string =>
  decision.detail

export const harnessReloadReply = (outcome: HarnessReloadOutcome): string =>
  formatHarnessReloadOutcome(outcome)
