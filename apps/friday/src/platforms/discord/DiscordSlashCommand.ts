import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { AdminConfig } from '../../config/AppConfig.ts'
import { formatConfigReloadOutcome, type ConfigReloadOutcome } from '../../config/ConfigReload.ts'

export const FRIDAY_COMMAND_NAME = 'friday'
export const FRIDAY_RELOAD_SUBCOMMAND = 'reload'

/**
 * Decision for one `/friday` application command interaction. The Discord
 * transport applies the decision; authorization uses stable Discord user IDs
 * from the pinned startup admin allow-list.
 */
export type FridayCommandDecision =
  | { readonly kind: 'reload' }
  | { readonly kind: 'usage'; readonly detail: string }
  | { readonly kind: 'unauthorized' }

const FridayInteraction = Schema.Struct({
  data: Schema.optionalKey(
    Schema.Struct({
      options: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
    }),
  ),
})
/** Parses the raw adapter interaction payload; run this at the transport boundary. */
export const decodeFridayInteraction = Schema.decodeUnknownOption(FridayInteraction)

/**
 * Extracts the invoked `/friday` subcommand from the raw adapter interaction
 * payload. Gateway interactions normalize the subcommand into `data.options`.
 */
export const fridaySubcommand = (
  interaction: typeof FridayInteraction.Type,
): Option.Option<string> => Option.fromNullishOr(interaction.data?.options?.[0]?.name)

/**
 * Pure decision for a `/friday` interaction. Only the `reload` subcommand is
 * recognized; any other subcommand (or a non-admin caller for `reload`) receives
 * guidance instead of performing the operation.
 */
export const decideFridayCommand = (input: {
  readonly subcommand: Option.Option<string>
  readonly userId: string
  readonly admin: AdminConfig
}): FridayCommandDecision => {
  if (input.subcommand._tag !== 'Some' || input.subcommand.value !== FRIDAY_RELOAD_SUBCOMMAND) {
    return {
      kind: 'usage',
      detail: `Usage: /${FRIDAY_COMMAND_NAME} ${FRIDAY_RELOAD_SUBCOMMAND}`,
    }
  }
  if (!input.admin.discordUserIds.includes(input.userId)) {
    return { kind: 'unauthorized' }
  }
  return { kind: 'reload' }
}

export const fridayCommandReply = (
  decision: Exclude<FridayCommandDecision, { kind: 'reload' }>,
): string =>
  decision.kind === 'usage'
    ? decision.detail
    : 'Only configured Friday administrators may reload the configuration.'

export const fridayReloadReply = (outcome: ConfigReloadOutcome): string =>
  formatConfigReloadOutcome(outcome)
