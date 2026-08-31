import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { AppConfigError } from './AppConfig.ts'

/** The slice of the configuration service the shared reload operation needs. */
export interface ConfigReloadSource {
  readonly reload: Effect.Effect<number, AppConfigError>
}

/**
 * Structured result of the shared administrative configuration-reload operation.
 * Both transports (Discord application command and local control socket) encode
 * this outcome; failures never throw across the transport boundary.
 */
export const ConfigReloadOutcome = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    version: Schema.Int,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals(['unauthorized', 'reload-failed', 'transport']),
    detail: Schema.String,
  }),
])
export type ConfigReloadOutcome = typeof ConfigReloadOutcome.Type

export const reloadSucceeded = (version: number): ConfigReloadOutcome => ({
  ok: true,
  version,
})

export const reloadUnauthorized = (detail: string): ConfigReloadOutcome => ({
  ok: false,
  reason: 'unauthorized',
  detail,
})

export const reloadFailed = (detail: string): ConfigReloadOutcome => ({
  ok: false,
  reason: 'reload-failed',
  detail,
})

/**
 * The shared application/admin operation: run one full configuration reload and
 * report the result as a structured outcome. Transports authorize the caller
 * before invoking this operation.
 */
export const reloadApplicationConfig = (
  config: ConfigReloadSource,
): Effect.Effect<ConfigReloadOutcome> =>
  config.reload.pipe(
    Effect.map(reloadSucceeded),
    Effect.catch((cause) => Effect.succeed(reloadFailed(cause.detail))),
  )

/** Human-readable one-line summary shared by the Discord reply and the CLI output. */
export const formatConfigReloadOutcome = (outcome: ConfigReloadOutcome): string =>
  outcome.ok
    ? `Configuration reloaded (version ${outcome.version}).`
    : `Configuration reload failed (${outcome.reason}): ${outcome.detail}`
