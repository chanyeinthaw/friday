/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL result rows are not consumed; the statement result is discarded. */

import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export class DiscordActivityDescriptionError extends Schema.Error<DiscordActivityDescriptionError>(
  'DiscordActivityDescriptionError',
)({
  _tag: Schema.tag('DiscordActivityDescriptionError'),
  operation: Schema.Literals(['set', 'reset']),
  connectionId: PlatformConnectionId,
  cause: Schema.Defect(),
}) {}

export interface DiscordActivityDescriptionsContract {
  readonly set: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<void, DiscordActivityDescriptionError>
  readonly reset: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<void, DiscordActivityDescriptionError>
}

export class DiscordActivityDescriptions extends Context.Service<
  DiscordActivityDescriptions,
  DiscordActivityDescriptionsContract
>()('friday/platforms/DiscordActivityDescriptions') {}

export const DiscordActivityDescriptionsLive = Layer.effect(
  DiscordActivityDescriptions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const update = (connectionId: PlatformConnectionId, enabled: boolean) =>
      sql`
        UPDATE discord_connections
        SET activity_description_public = ${enabled ? 1 : 0}
        WHERE connection_id = ${connectionId}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new DiscordActivityDescriptionError({
              operation: enabled ? 'set' : 'reset',
              connectionId,
              cause,
            }),
        ),
      )

    return DiscordActivityDescriptions.of({
      set: (connectionId) => update(connectionId, true),
      reset: (connectionId) => update(connectionId, false),
    })
  }),
)
