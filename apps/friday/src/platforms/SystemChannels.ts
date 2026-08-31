/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL result rows are not consumed; the statement result is discarded. */

import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export class SystemChannelError extends Schema.Error<SystemChannelError>('SystemChannelError')({
  _tag: Schema.tag('SystemChannelError'),
  operation: Schema.Literals(['set', 'reset']),
  connectionId: PlatformConnectionId,
  channelId: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface SystemChannelsContract {
  readonly set: (
    connectionId: PlatformConnectionId,
    channelId: string,
  ) => Effect.Effect<void, SystemChannelError>
  readonly reset: (
    connectionId: PlatformConnectionId,
    channelId: string,
  ) => Effect.Effect<void, SystemChannelError>
}

export class SystemChannels extends Context.Service<SystemChannels, SystemChannelsContract>()(
  'friday/platforms/SystemChannels',
) {}

export const SystemChannelsLive = Layer.effect(
  SystemChannels,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return SystemChannels.of({
      set: (connectionId, channelId) =>
        sql`
          INSERT INTO platform_system_channels (
            connection_id, channel_id, created_at, updated_at
          ) VALUES (
            ${connectionId}, ${channelId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT (connection_id, channel_id) DO UPDATE SET
            updated_at = CURRENT_TIMESTAMP
        `.pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new SystemChannelError({
                operation: 'set',
                connectionId,
                channelId,
                cause,
              }),
          ),
        ),
      reset: (connectionId, channelId) =>
        sql`
          DELETE FROM platform_system_channels
          WHERE connection_id = ${connectionId}
            AND channel_id = ${channelId}
        `.pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new SystemChannelError({
                operation: 'reset',
                connectionId,
                channelId,
                cause,
              }),
          ),
        ),
    })
  }),
)
