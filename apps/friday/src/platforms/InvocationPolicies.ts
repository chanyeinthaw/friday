/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL rows are decoded immediately through Effect Schema. */

import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { InvocationMode, type InvocationMode as InvocationModeType } from '../config/AppConfig.ts'
import type { ChatSdkInboundKind } from './chat-sdk/ChatSdkLifecycle.ts'

const ChannelId = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

export const InvocationPolicyConfiguration = Schema.Struct({
  defaultMode: InvocationMode,
  channels: Schema.Array(Schema.Struct({ channelId: ChannelId, mode: InvocationMode })),
})
export type InvocationPolicyConfiguration = typeof InvocationPolicyConfiguration.Type

export const ChannelInvocationPolicy = Schema.Struct({
  connectionId: PlatformConnectionId,
  channelId: ChannelId,
  mode: InvocationMode,
})
export type ChannelInvocationPolicy = typeof ChannelInvocationPolicy.Type

const ModeRow = Schema.Struct({ mode: InvocationMode })
const ChannelModeRow = Schema.Struct({ channel_id: Schema.String, mode: InvocationMode })
const decodeModeRows = Schema.decodeUnknownEffect(Schema.Array(ModeRow))
const decodeChannelModeRows = Schema.decodeUnknownEffect(Schema.Array(ChannelModeRow))

export class InvocationPolicyError extends Schema.Error<InvocationPolicyError>(
  'InvocationPolicyError',
)({
  _tag: Schema.tag('InvocationPolicyError'),
  operation: Schema.Literals(['read', 'write']),
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const shouldInvoke = (input: {
  readonly kind: ChatSdkInboundKind
  readonly mode: InvocationModeType
  readonly hasBinding: boolean
}): boolean =>
  input.kind === 'mention' ||
  input.kind === 'direct-message' ||
  input.mode === 'all-messages' ||
  input.hasBinding

export interface InvocationPoliciesContract {
  readonly configuration: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<InvocationPolicyConfiguration, InvocationPolicyError>
  readonly watch: (
    connectionId: PlatformConnectionId,
    onChange: (configuration: InvocationPolicyConfiguration) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly effectiveMode: (
    connectionId: PlatformConnectionId,
    channelId: string,
  ) => Effect.Effect<InvocationMode, InvocationPolicyError>
  readonly setChannelMode: (
    policy: ChannelInvocationPolicy,
  ) => Effect.Effect<void, InvocationPolicyError>
  readonly setDefaultMode: (
    connectionId: PlatformConnectionId,
    mode: InvocationMode,
  ) => Effect.Effect<void, InvocationPolicyError>
}

export class InvocationPolicies extends Context.Service<
  InvocationPolicies,
  InvocationPoliciesContract
>()('friday/platforms/InvocationPolicies') {}

export const InvocationPoliciesLive = Layer.effect(
  InvocationPolicies,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const readError = (cause: unknown) =>
      new InvocationPolicyError({
        operation: 'read',
        detail: 'Could not read the platform invocation policy.',
        cause,
      })
    const writeError = (cause: unknown) =>
      new InvocationPolicyError({
        operation: 'write',
        detail: 'Could not update the platform invocation policy.',
        cause,
      })

    const configuration = Effect.fn('InvocationPolicies.configuration')(function* (
      connectionId: PlatformConnectionId,
    ) {
      const defaultRows = yield* sql<Record<string, unknown>>`
        SELECT mode
        FROM platform_invocation_defaults
        WHERE connection_id = ${connectionId}
        LIMIT 1
      `
      const channelRows = yield* sql<Record<string, unknown>>`
        SELECT channel_id, mode
        FROM platform_channel_invocation_policies
        WHERE connection_id = ${connectionId}
        ORDER BY channel_id
      `
      return InvocationPolicyConfiguration.make({
        defaultMode: (yield* decodeModeRows(defaultRows))[0]?.mode ?? 'mention-only',
        channels: (yield* decodeChannelModeRows(channelRows)).map((row) => ({
          channelId: row.channel_id,
          mode: row.mode,
        })),
      })
    })

    const configured = (connectionId: PlatformConnectionId) =>
      configuration(connectionId).pipe(Effect.mapError(readError))

    return InvocationPolicies.of({
      configuration: configured,
      watch: (connectionId, onChange) => {
        let previous = ''
        const refresh = configured(connectionId).pipe(
          Effect.flatMap((next) => {
            const identity = `${next.defaultMode}:${next.channels.map(({ channelId, mode }) => `${channelId}=${mode}`).join(',')}`
            if (identity === previous) return Effect.void
            previous = identity
            return onChange(next)
          }),
          Effect.tapError((cause) =>
            Effect.logWarning('platform.invocation.refresh-failed').pipe(
              Effect.annotateLogs({ connectionId, cause: String(cause) }),
            ),
          ),
          Effect.ignore,
        )
        return refresh.pipe(
          Effect.repeat(Schedule.spaced('5 seconds')),
          Effect.forkScoped,
          Effect.asVoid,
        )
      },
      effectiveMode: (connectionId, channelId) =>
        Effect.gen(function* () {
          const channelRows = yield* sql<Record<string, unknown>>`
            SELECT mode
            FROM platform_channel_invocation_policies
            WHERE connection_id = ${connectionId} AND channel_id = ${channelId}
            LIMIT 1
          `
          const channel = (yield* decodeModeRows(channelRows))[0]
          if (channel) return channel.mode
          const defaultRows = yield* sql<Record<string, unknown>>`
            SELECT mode
            FROM platform_invocation_defaults
            WHERE connection_id = ${connectionId}
            LIMIT 1
          `
          return (yield* decodeModeRows(defaultRows))[0]?.mode ?? 'mention-only'
        }).pipe(Effect.mapError(readError)),
      setChannelMode: ({ connectionId, channelId, mode }) =>
        sql`
          INSERT INTO platform_channel_invocation_policies (connection_id, channel_id, mode)
          VALUES (${connectionId}, ${channelId}, ${mode})
          ON CONFLICT(connection_id, channel_id) DO UPDATE SET mode = excluded.mode
        `.pipe(Effect.asVoid, Effect.mapError(writeError)),
      setDefaultMode: (connectionId, mode) =>
        sql`
          INSERT INTO platform_invocation_defaults (connection_id, mode)
          VALUES (${connectionId}, ${mode})
          ON CONFLICT(connection_id) DO UPDATE SET mode = excluded.mode
        `.pipe(Effect.asVoid, Effect.mapError(writeError)),
    })
  }),
)
