import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { AdminConfig } from '../../config/AppConfig.ts'
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
 * transport applies the decision; authorization uses stable Discord user IDs
 * from the pinned startup admin allow-list.
 */
export type HarnessCommandDecision =
  | { readonly kind: 'reload' }
  | { readonly kind: 'usage'; readonly detail: string }
  | { readonly kind: 'unauthorized' }

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
 * recognized; any other subcommand (or a non-admin caller for `reload`)
 * receives guidance instead of performing the operation.
 */
export const decideHarnessCommand = (input: {
  readonly subcommand: Option.Option<string>
  readonly userId: string
  readonly admin: AdminConfig
}): HarnessCommandDecision => {
  if (input.subcommand._tag !== 'Some' || input.subcommand.value !== HARNESS_RELOAD_SUBCOMMAND) {
    return {
      kind: 'usage',
      detail: `Usage: /${HARNESS_COMMAND_NAME} ${HARNESS_RELOAD_SUBCOMMAND}`,
    }
  }
  if (!input.admin.discordUserIds.includes(input.userId)) {
    return { kind: 'unauthorized' }
  }
  return { kind: 'reload' }
}

export const harnessCommandReply = (
  decision: Exclude<HarnessCommandDecision, { kind: 'reload' }>,
): string =>
  decision.kind === 'usage'
    ? decision.detail
    : 'Only configured Friday administrators may reload the harness.'

export const harnessReloadReply = (outcome: HarnessReloadOutcome): string =>
  formatHarnessReloadOutcome(outcome)
