import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { OptChatBinding } from './AppConfig.ts'

export class OptChatConfigurationError extends Schema.Error<OptChatConfigurationError>(
  'OptChatConfigurationError',
)({
  _tag: Schema.tag('OptChatConfigurationError'),
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface OptChatConfigurationContract {
  readonly list: () => Effect.Effect<
    ReadonlyArray<OptChatBinding & { enabled: number }>,
    OptChatConfigurationError
  >
  readonly add: (binding: OptChatBinding) => Effect.Effect<void, OptChatConfigurationError>
  readonly disable: (id: string) => Effect.Effect<void, OptChatConfigurationError>
}
export class OptChatConfiguration extends Context.Service<
  OptChatConfiguration,
  OptChatConfigurationContract
>()('friday/OptChatConfiguration') {}

export const isOptChatConfigurationError = Schema.is(OptChatConfigurationError)
const decodeBindings = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...OptChatBinding.fields, enabled: Schema.Int })),
)
const decodeBinding = Schema.decodeUnknownEffect(OptChatBinding)

export const OptChatConfigurationLive = Layer.effect(
  OptChatConfiguration,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const error = (cause: unknown) =>
      new OptChatConfigurationError({ detail: 'OptChat configuration failed.', cause })
    return OptChatConfiguration.of({
      list: Effect.fn('OptChatConfiguration.list')(
        function* () {
          return yield* decodeBindings(
            yield* sql`SELECT id, platform, connection_id AS connectionId, channel_id AS channelId, owner_user_id AS ownerUserId, enabled FROM optchat_bindings ORDER BY id`,
          )
        },
        (effect) => effect.pipe(Effect.mapError(error)),
      ),
      add: Effect.fn('OptChatConfiguration.add')(
        function* (binding) {
          const validated = yield* decodeBinding(binding)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const connections =
                yield* sql`SELECT connection_id FROM platform_connections WHERE connection_id = ${validated.connectionId} AND platform = ${validated.platform}`
              if (connections.length === 0)
                return yield* new OptChatConfigurationError({
                  detail: 'The platform connection does not exist or has a different platform.',
                })
              // Identity is immutable: re-enabling a binding cannot transfer its memory to another owner.
              const existing =
                yield* sql`SELECT id FROM optchat_bindings WHERE id = ${validated.id}`
              if (existing.length > 0) {
                const matching =
                  yield* sql`SELECT id FROM optchat_bindings WHERE id = ${validated.id} AND platform = ${validated.platform} AND connection_id = ${validated.connectionId} AND channel_id = ${validated.channelId} AND owner_user_id = ${validated.ownerUserId}`
                if (matching.length === 0)
                  return yield* new OptChatConfigurationError({
                    detail: 'This memory ID is already bound to a different channel or owner.',
                  })
                yield* sql`UPDATE optchat_bindings SET enabled = 1 WHERE id = ${validated.id}`
              } else
                yield* sql`INSERT INTO optchat_bindings (id, platform, connection_id, channel_id, owner_user_id) VALUES (${validated.id}, ${validated.platform}, ${validated.connectionId}, ${validated.channelId}, ${validated.ownerUserId})`
            }),
          )
        },
        (effect) =>
          effect.pipe(
            Effect.mapError((cause) => (isOptChatConfigurationError(cause) ? cause : error(cause))),
          ),
      ),
      disable: Effect.fn('OptChatConfiguration.disable')(
        function* (id) {
          yield* sql`UPDATE optchat_bindings SET enabled = 0 WHERE id = ${id}`
        },
        (effect) => effect.pipe(Effect.mapError(error)),
      ),
    })
  }),
)
