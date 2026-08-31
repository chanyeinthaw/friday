/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL rows are decoded immediately through Effect Schema. */

import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../persistence/Migrations.ts'

const ActivityDescriptionRow = Schema.Struct({ activity_description_public: Schema.Number })
const ConnectionPlatformRow = Schema.Struct({ platform: Schema.String })
const UpdatedConnectionRow = Schema.Struct({ connection_id: Schema.String })
const decodeActivityDescriptionRows = Schema.decodeUnknownEffect(
  Schema.Array(ActivityDescriptionRow),
)
const decodeConnectionPlatformRows = Schema.decodeUnknownEffect(Schema.Array(ConnectionPlatformRow))
const decodeUpdatedConnectionRows = Schema.decodeUnknownEffect(Schema.Array(UpdatedConnectionRow))

export class DiscordActivityDescriptionError extends Schema.Error<DiscordActivityDescriptionError>(
  'DiscordActivityDescriptionError',
)({
  _tag: Schema.tag('DiscordActivityDescriptionError'),
  operation: Schema.Literals(['read', 'set', 'reset']),
  connectionId: PlatformConnectionId,
  cause: Schema.Defect(),
}) {}

export class UnknownPlatformConnectionError extends Schema.Error<UnknownPlatformConnectionError>(
  'UnknownPlatformConnectionError',
)({
  _tag: Schema.tag('UnknownPlatformConnectionError'),
  connectionId: PlatformConnectionId,
}) {}

export class NonDiscordPlatformConnectionError extends Schema.Error<NonDiscordPlatformConnectionError>(
  'NonDiscordPlatformConnectionError',
)({
  _tag: Schema.tag('NonDiscordPlatformConnectionError'),
  connectionId: PlatformConnectionId,
  platform: Schema.String,
}) {}

export type DiscordActivityDescriptionUpdateError =
  | DiscordActivityDescriptionError
  | UnknownPlatformConnectionError
  | NonDiscordPlatformConnectionError

export interface DiscordActivityDescriptionsContract {
  readonly enabled: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<boolean, DiscordActivityDescriptionError>
  readonly watch: (
    connectionId: PlatformConnectionId,
    onChange: (enabled: boolean) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly set: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<void, DiscordActivityDescriptionUpdateError>
  readonly reset: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<void, DiscordActivityDescriptionUpdateError>
}

export class DiscordActivityDescriptions extends Context.Service<
  DiscordActivityDescriptions,
  DiscordActivityDescriptionsContract
>()('friday/platforms/DiscordActivityDescriptions') {}

export const DiscordActivityDescriptionsLive = Layer.effect(
  DiscordActivityDescriptions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* runMigrations()

    const read = Effect.fn('DiscordActivityDescriptions.enabled')(function* (
      connectionId: PlatformConnectionId,
    ) {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT activity_description_public
        FROM discord_connections
        WHERE connection_id = ${connectionId}
        LIMIT 1
      `
      return (yield* decodeActivityDescriptionRows(rows))[0]?.activity_description_public === 1
    })

    const enabled = (connectionId: PlatformConnectionId) =>
      read(connectionId).pipe(
        Effect.mapError(
          (cause) =>
            new DiscordActivityDescriptionError({ operation: 'read', connectionId, cause }),
        ),
      )

    const connectionPlatform = Effect.fn('DiscordActivityDescriptions.connectionPlatform')(
      function* (connectionId: PlatformConnectionId) {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT platform
          FROM platform_connections
          WHERE connection_id = ${connectionId}
          LIMIT 1
        `
        return (yield* decodeConnectionPlatformRows(rows))[0]
      },
    )

    const update = Effect.fn('DiscordActivityDescriptions.update')(function* (
      connectionId: PlatformConnectionId,
      nextEnabled: boolean,
    ) {
      const operation = nextEnabled ? ('set' as const) : ('reset' as const)
      const rows = yield* sql<Record<string, unknown>>`
        UPDATE discord_connections
        SET activity_description_public = ${nextEnabled ? 1 : 0}
        WHERE connection_id = ${connectionId}
          AND EXISTS (
            SELECT 1
            FROM platform_connections
            WHERE platform_connections.connection_id = discord_connections.connection_id
              AND platform_connections.platform = 'discord'
          )
        RETURNING connection_id
      `.pipe(
        Effect.mapError(
          (cause) => new DiscordActivityDescriptionError({ operation, connectionId, cause }),
        ),
      )
      const updated = yield* decodeUpdatedConnectionRows(rows).pipe(
        Effect.mapError(
          (cause) => new DiscordActivityDescriptionError({ operation, connectionId, cause }),
        ),
      )
      if (updated[0] !== undefined) return

      const connection = yield* connectionPlatform(connectionId).pipe(
        Effect.mapError(
          (cause) => new DiscordActivityDescriptionError({ operation, connectionId, cause }),
        ),
      )
      if (connection === undefined)
        return yield* new UnknownPlatformConnectionError({ connectionId })
      return yield* new NonDiscordPlatformConnectionError({
        connectionId,
        platform: connection.platform,
      })
    })

    return DiscordActivityDescriptions.of({
      enabled,
      watch: (connectionId, onChange) => {
        let previous: boolean | undefined
        const refresh = enabled(connectionId).pipe(
          Effect.flatMap((next) => {
            if (next === previous) return Effect.void
            previous = next
            return onChange(next)
          }),
          Effect.tapError((cause) =>
            Effect.logWarning('discord.activity-description.refresh-failed').pipe(
              Effect.annotateLogs({ connectionId, cause: String(cause) }),
            ),
          ),
          Effect.ignore,
        )
        return refresh.pipe(
          Effect.repeat(Schedule.spaced('1 second')),
          Effect.forkScoped,
          Effect.asVoid,
        )
      },
      set: (connectionId) => update(connectionId, true),
      reset: (connectionId) => update(connectionId, false),
    })
  }),
)
