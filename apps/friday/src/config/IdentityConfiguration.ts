/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQLite rows are decoded immediately through Effect Schema. */

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../persistence/Migrations.ts'

export const IdentityText = Schema.String.pipe(Schema.brand('IdentityText'))
export type IdentityText = typeof IdentityText.Type

export const DefaultIdentityText: IdentityText =
  Schema.decodeSync(IdentityText)('Your name is Friday')

export type IdentityTextSetOutcome = 'updated' | 'unchanged'

export class IdentityConfigurationError extends Schema.Error<IdentityConfigurationError>(
  'IdentityConfigurationError',
)({
  _tag: Schema.tag('IdentityConfigurationError'),
  operation: Schema.Literals(['get', 'set', 'migrate', 'decode']),
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const summary = `Identity configuration ${this.operation} failed.`
    return this.detail === undefined ? summary : `${summary} ${this.detail}`
  }
}

export interface IdentityConfigurationContract {
  readonly get: () => Effect.Effect<IdentityText, IdentityConfigurationError>
  readonly set: (
    text: IdentityText,
  ) => Effect.Effect<IdentityTextSetOutcome, IdentityConfigurationError>
}

export class IdentityConfiguration extends Context.Service<
  IdentityConfiguration,
  IdentityConfigurationContract
>()('friday/config/IdentityConfiguration') {}

const IdentityRow = Schema.Struct({ identity_text: Schema.String })
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(IdentityRow))
const decodeIdentityText = Schema.decodeUnknownEffect(IdentityText)

export const IdentityConfigurationLive = Layer.effect(
  IdentityConfiguration,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const error = (operation: IdentityConfigurationError['operation']) => (cause: unknown) =>
      new IdentityConfigurationError({
        operation,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      })

    yield* runMigrations().pipe(Effect.mapError(error('migrate')))

    const get = Effect.fn('IdentityConfiguration.get')(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT identity_text FROM agent_config WHERE id = 1
      `.pipe(Effect.mapError(error('get')))
      const decoded = yield* decodeRows(rows).pipe(Effect.mapError(error('decode')))
      const row = decoded[0]
      if (row === undefined) {
        return yield* new IdentityConfigurationError({
          operation: 'get',
          detail: 'agent_config row is missing',
        })
      }
      return yield* decodeIdentityText(row.identity_text).pipe(Effect.mapError(error('decode')))
    })

    const set = Effect.fn('IdentityConfiguration.set')(function* (text: IdentityText) {
      const current = yield* get()
      if (current === text) return 'unchanged' as const
      yield* sql`
        UPDATE agent_config
        SET identity_text = ${text}, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `.pipe(Effect.mapError(error('set')))
      return 'updated' as const
    })

    return IdentityConfiguration.of({ get, set })
  }),
)
