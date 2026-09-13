/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL rows are decoded immediately through Effect Schema. */

import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import type { AccessPolicy, InvocationMode, ReplyMode } from './AppConfig.ts'
import {
  InvocationMode as InvocationModeSchema,
  ReplyMode as ReplyModeSchema,
} from './AppConfig.ts'
import { runMigrations } from '../persistence/Migrations.ts'

/** Name of the environment variable holding a Slack token; tokens are never stored. */
export const SlackTokenEnvName = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  Schema.brand('SlackTokenEnvName'),
)
export type SlackTokenEnvName = typeof SlackTokenEnvName.Type

/** A Slack channel, DM, or group id (`C...`, `D...`, `G...`). */
export const SlackChannelId = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isNonEmpty()),
  Schema.brand('SlackChannelId'),
)
export type SlackChannelId = typeof SlackChannelId.Type

export interface SlackConnectionRecord {
  readonly connectionId: string
  readonly name: string
  readonly enabled: boolean
}

/** One stored Slack connection with its restart-pinned topology and live policy. */
export interface SlackConnectionDetail {
  readonly connectionId: string
  readonly name: string
  readonly enabled: boolean
  readonly botTokenEnv: string
  readonly appTokenEnv: string
  readonly defaultReplyMode: ReplyMode
  readonly users: AccessPolicy
  readonly channels: AccessPolicy
  readonly workspaces: AccessPolicy
  readonly channelOverrides: ReadonlyArray<{
    readonly channelId: string
    readonly invocationMode?: InvocationMode
    readonly replyMode?: ReplyMode
  }>
}

/** Everything the add command persists. */
export interface SlackConnectionInput {
  readonly connectionId: PlatformConnectionId
  readonly name: string
  readonly botTokenEnv: SlackTokenEnvName
  readonly appTokenEnv: SlackTokenEnvName
  readonly defaultReplyMode?: ReplyMode | undefined
}

export type SlackConnectionAddOutcome = 'added' | 'connection-exists'
export type SlackConnectionRemoveOutcome = 'removed' | 'missing'
export type SlackConnectionEnableOutcome = 'enabled' | 'already-enabled' | 'missing'
export type SlackConnectionDisableOutcome = 'disabled' | 'already-disabled' | 'missing'
export type SlackConnectionUpdateOutcome = 'updated' | 'unchanged' | 'missing'
export type SlackAccessUpdateOutcome = 'updated' | 'unchanged' | 'missing'
export type SlackChannelUpdateOutcome = 'updated' | 'unchanged' | 'missing-connection'
export type SlackChannelResetOutcome = 'removed' | 'missing'

/** One channel override to apply; absent fields keep their current value. */
export interface SlackChannelPatch {
  readonly invocationMode?: InvocationMode
  readonly replyMode?: ReplyMode
}

/** Mutable assembly shape for a channel override read from SQLite. */
interface AssembledSlackChannelOverride {
  channelId: string
  invocationMode?: InvocationMode
  replyMode?: ReplyMode
}

/**
 * Partial update of one stored Slack connection; absent fields keep their
 * current value. Tokens stay indirected: only environment variable names are stored.
 */
export interface SlackConnectionUpdate {
  readonly connectionId: PlatformConnectionId
  readonly name?: string
  readonly botTokenEnv?: SlackTokenEnvName
  readonly appTokenEnv?: SlackTokenEnvName
  readonly defaultReplyMode?: ReplyMode
}

export type SlackAccessSubject = 'users' | 'channels' | 'workspaces'

export class SlackConnectionError extends Schema.Error<SlackConnectionError>(
  'SlackConnectionError',
)({
  _tag: Schema.tag('SlackConnectionError'),
  operation: Schema.Literals(['read', 'write', 'unknown-connection', 'non-slack-connection']),
  connectionId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.connectionId === undefined
      ? `Slack connection ${this.operation} failed.`
      : `Slack connection ${this.operation} failed for ${this.connectionId}.`
  }
}

export interface SlackConnectionsContract {
  /** Lists Slack connections in stable connection-id order. */
  readonly listConnections: () => Effect.Effect<
    ReadonlyArray<SlackConnectionRecord>,
    SlackConnectionError
  >
  /** Reads one connection's stored configuration; `None` when not configured. */
  readonly getConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<Option.Option<SlackConnectionDetail>, SlackConnectionError>
  /**
   * Adds a Slack Socket Mode connection with safe defaults. The change
   * requires a Friday restart to take effect.
   */
  readonly addConnection: (
    input: SlackConnectionInput,
  ) => Effect.Effect<SlackConnectionAddOutcome, SlackConnectionError>
  /** Removes a connection together with its Slack configuration. Idempotent. */
  readonly removeConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<SlackConnectionRemoveOutcome, SlackConnectionError>
  /** Enables a configured Slack connection; applies on restart. */
  readonly enableConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<SlackConnectionEnableOutcome, SlackConnectionError>
  /** Disables a configured Slack connection; applies on restart. */
  readonly disableConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<SlackConnectionDisableOutcome, SlackConnectionError>
  /** Updates stored connection fields, preserving every unspecified field. */
  readonly updateConnection: (
    update: SlackConnectionUpdate,
  ) => Effect.Effect<SlackConnectionUpdateOutcome, SlackConnectionError>
  /** Replaces one access policy (users, channels, or workspaces). Applies live on reload. */
  readonly setAccessPolicy: (
    connectionId: PlatformConnectionId,
    subject: SlackAccessSubject,
    policy: AccessPolicy,
  ) => Effect.Effect<SlackAccessUpdateOutcome, SlackConnectionError>
  /**
   * Upserts one channel override. Absent patch fields keep their current
   * value, so a row only carries the overrides it needs. Applies live on
   * reload.
   */
  readonly setChannel: (
    connectionId: PlatformConnectionId,
    channelId: SlackChannelId,
    patch: SlackChannelPatch,
  ) => Effect.Effect<SlackChannelUpdateOutcome, SlackConnectionError>
  /** Removes one channel override, restoring the connection default. */
  readonly resetChannel: (
    connectionId: PlatformConnectionId,
    channelId: SlackChannelId,
  ) => Effect.Effect<SlackChannelResetOutcome, SlackConnectionError>
}

export class SlackConnections extends Context.Service<SlackConnections, SlackConnectionsContract>()(
  'friday/config/SlackConnections',
) {}

const SlackConnectionListRow = Schema.Struct({
  connection_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Number,
})
const decodeSlackConnectionListRows = Schema.decodeUnknownEffect(
  Schema.Array(SlackConnectionListRow),
)
const SlackConnectionDetailRow = Schema.Struct({
  connection_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Number,
  bot_token_env: Schema.String,
  app_token_env: Schema.String,
  default_reply_mode: ReplyModeSchema,
})
const decodeSlackConnectionDetailRows = Schema.decodeUnknownEffect(
  Schema.Array(SlackConnectionDetailRow),
)
const PlatformRow = Schema.Struct({ platform: Schema.String })
const decodePlatformRows = Schema.decodeUnknownEffect(Schema.Array(PlatformRow))
const AccessRow = Schema.Struct({
  connection_id: Schema.String,
  subject_type: Schema.String,
  mode: Schema.Literals(['all', 'allow', 'deny']),
})
const decodeAccessRows = Schema.decodeUnknownEffect(Schema.Array(AccessRow))
const AccessSubjectRow = Schema.Struct({
  connection_id: Schema.String,
  subject_type: Schema.String,
  platform_subject_id: Schema.String,
})
const decodeAccessSubjectRows = Schema.decodeUnknownEffect(Schema.Array(AccessSubjectRow))
const SlackChannelRow = Schema.Struct({
  connection_id: Schema.String,
  channel_id: Schema.String,
  invocation_mode: Schema.NullOr(InvocationModeSchema),
  reply_mode: Schema.NullOr(ReplyModeSchema),
})
const decodeSlackChannelRows = Schema.decodeUnknownEffect(Schema.Array(SlackChannelRow))

const subjectTypeFor = (subject: SlackAccessSubject): string =>
  subject === 'users' ? 'user' : subject === 'channels' ? 'channel' : 'workspace'

/**
 * Direct SQLite administration of Slack connection lifecycle. Like the other
 * config CLI services, these commands never use the control socket, so they
 * work while Friday is not running; connection topology is pinned to the
 * startup snapshot, so lifecycle changes require a restart while access and
 * reply policy reload live.
 */
export const SlackConnectionsLive = Layer.effect(
  SlackConnections,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* runMigrations().pipe(Effect.orDie)

    const readError = (connectionId?: PlatformConnectionId) => (cause: unknown) =>
      new SlackConnectionError({ operation: 'read', connectionId, cause })
    const writeError = (connectionId: PlatformConnectionId) => (cause: unknown) =>
      new SlackConnectionError({ operation: 'write', connectionId, cause })

    const platformOf = (connectionId: PlatformConnectionId) =>
      sql<Record<string, unknown>>`
        SELECT platform FROM platform_connections
        WHERE connection_id = ${connectionId}
        LIMIT 1
      `.pipe(
        Effect.mapError(readError(connectionId)),
        Effect.flatMap((rows) =>
          Effect.map(
            decodePlatformRows(rows).pipe(Effect.mapError(readError(connectionId))),
            (decoded) => decoded[0]?.platform,
          ),
        ),
      )

    const readDetail = (
      connectionId: PlatformConnectionId,
    ): Effect.Effect<Option.Option<SlackConnectionDetail>, SlackConnectionError> =>
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
          SELECT
            platform_connections.connection_id,
            platform_connections.name,
            platform_connections.enabled,
            slack_connections.bot_token_env,
            slack_connections.app_token_env,
            slack_connections.default_reply_mode
          FROM platform_connections
          JOIN slack_connections USING (connection_id)
          WHERE platform_connections.connection_id = ${connectionId}
            AND platform_connections.platform = 'slack'
        `.pipe(Effect.mapError(readError(connectionId)))
        const decoded = yield* decodeSlackConnectionDetailRows(rows).pipe(
          Effect.mapError(readError(connectionId)),
        )
        const row = decoded[0]
        if (row === undefined) return Option.none()
        const policyRows = yield* sql<Record<string, unknown>>`
          SELECT connection_id, subject_type, mode FROM platform_access_policies
          WHERE connection_id = ${connectionId}
        `.pipe(Effect.mapError(readError(connectionId)))
        const policies = yield* decodeAccessRows(policyRows).pipe(
          Effect.mapError(readError(connectionId)),
        )
        const subjectRows = yield* sql<Record<string, unknown>>`
          SELECT connection_id, subject_type, platform_subject_id
          FROM platform_access_subjects
          WHERE connection_id = ${connectionId}
        `.pipe(Effect.mapError(readError(connectionId)))
        const subjects = yield* decodeAccessSubjectRows(subjectRows).pipe(
          Effect.mapError(readError(connectionId)),
        )
        const policyFor = (subjectType: string): AccessPolicy => {
          const policy = policies.find((candidate) => candidate.subject_type === subjectType)
          if (policy === undefined) return { mode: 'all', ids: [] }
          return {
            mode: policy.mode,
            ids: subjects
              .filter((subject) => subject.subject_type === subjectType)
              .map((subject) => subject.platform_subject_id),
          }
        }
        const channelRows = yield* sql<Record<string, unknown>>`
          SELECT connection_id, channel_id, invocation_mode, reply_mode FROM slack_channels
          WHERE connection_id = ${connectionId}
          ORDER BY channel_id
        `.pipe(Effect.mapError(readError(connectionId)))
        const channels = yield* decodeSlackChannelRows(channelRows).pipe(
          Effect.mapError(readError(connectionId)),
        )
        return Option.some({
          connectionId: row.connection_id,
          name: row.name,
          enabled: row.enabled === 1,
          botTokenEnv: row.bot_token_env,
          appTokenEnv: row.app_token_env,
          defaultReplyMode: row.default_reply_mode,
          users: policyFor('user'),
          channels: policyFor('channel'),
          workspaces: policyFor('workspace'),
          channelOverrides: channels.map((channel) => {
            const override: AssembledSlackChannelOverride = { channelId: channel.channel_id }
            if (channel.invocation_mode !== null) {
              override.invocationMode = channel.invocation_mode
            }
            if (channel.reply_mode !== null) {
              override.replyMode = channel.reply_mode
            }
            return override
          }),
        })
      })

    return SlackConnections.of({
      listConnections: () =>
        sql<Record<string, unknown>>`
          SELECT connection_id, name, enabled
          FROM platform_connections
          WHERE platform = 'slack'
          ORDER BY connection_id
        `.pipe(
          Effect.mapError(readError()),
          Effect.flatMap((rows) =>
            decodeSlackConnectionListRows(rows).pipe(Effect.mapError(readError())),
          ),
          Effect.map((rows) =>
            rows.map((row) => ({
              connectionId: row.connection_id,
              name: row.name,
              enabled: row.enabled === 1,
            })),
          ),
        ),

      getConnection: readDetail,

      addConnection: (input) =>
        Effect.gen(function* () {
          const platform = yield* platformOf(input.connectionId)
          if (platform !== undefined) return 'connection-exists' as const
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO platform_connections (
                  connection_id, platform, name, enabled, created_at, updated_at
                ) VALUES (
                  ${input.connectionId}, 'slack', ${input.name}, 1,
                  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                )
              `
              yield* sql`
                INSERT INTO slack_connections (
                  connection_id, bot_token_env, app_token_env, default_reply_mode
                ) VALUES (
                  ${input.connectionId}, ${input.botTokenEnv}, ${input.appTokenEnv},
                  ${input.defaultReplyMode ?? 'reply-in-thread'}
                )
              `
              return 'added' as const
            }),
          )
        }).pipe(Effect.mapError(writeError(input.connectionId))),

      removeConnection: (connectionId) =>
        Effect.gen(function* () {
          const platform = yield* platformOf(connectionId)
          if (platform !== 'slack') return 'missing' as const
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  DELETE FROM slack_connections WHERE connection_id = ${connectionId}
                `
                const deleted = yield* sql<Record<string, unknown>>`
                  DELETE FROM platform_connections
                  WHERE connection_id = ${connectionId} AND platform = 'slack'
                  RETURNING connection_id
                `
                if (deleted[0] === undefined) return 'missing' as const
                return 'removed' as const
              }),
            )
            .pipe(Effect.mapError(writeError(connectionId)))
        }).pipe(Effect.mapError(writeError(connectionId))),

      updateConnection: (update) =>
        Effect.gen(function* () {
          const platform = yield* platformOf(update.connectionId)
          if (platform !== 'slack') return 'missing' as const
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<Record<string, unknown>>`
                  SELECT
                    platform_connections.name AS name,
                    slack_connections.bot_token_env AS bot_token_env,
                    slack_connections.app_token_env AS app_token_env,
                    slack_connections.default_reply_mode AS default_reply_mode
                  FROM platform_connections
                  JOIN slack_connections USING (connection_id)
                  WHERE platform_connections.connection_id = ${update.connectionId}
                  LIMIT 1
                `
                const current = (yield* decodeSlackConnectionDetailRows(
                  rows.map((row) => ({
                    connection_id: update.connectionId,
                    name: row['name'],
                    enabled: 1,
                    bot_token_env: row['bot_token_env'],
                    app_token_env: row['app_token_env'],
                    default_reply_mode: row['default_reply_mode'],
                  })),
                ))[0]
                if (current === undefined) return 'missing' as const
                const nextName = update.name ?? current.name
                const nextBotTokenEnv = update.botTokenEnv ?? current.bot_token_env
                const nextAppTokenEnv = update.appTokenEnv ?? current.app_token_env
                const nextReplyMode = update.defaultReplyMode ?? current.default_reply_mode
                if (
                  nextName === current.name &&
                  nextBotTokenEnv === current.bot_token_env &&
                  nextAppTokenEnv === current.app_token_env &&
                  nextReplyMode === current.default_reply_mode
                ) {
                  return 'unchanged' as const
                }
                yield* sql`
                  UPDATE platform_connections
                  SET name = ${nextName}, updated_at = CURRENT_TIMESTAMP
                  WHERE connection_id = ${update.connectionId}
                `
                yield* sql`
                  UPDATE slack_connections
                  SET bot_token_env = ${nextBotTokenEnv},
                    app_token_env = ${nextAppTokenEnv},
                    default_reply_mode = ${nextReplyMode}
                  WHERE connection_id = ${update.connectionId}
                `
                return 'updated' as const
              }),
            )
            .pipe(Effect.mapError(writeError(update.connectionId)))
        }).pipe(Effect.mapError(writeError(update.connectionId))),

      enableConnection: (connectionId) =>
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
          UPDATE platform_connections SET enabled = 1, updated_at = CURRENT_TIMESTAMP
          WHERE connection_id = ${connectionId} AND platform = 'slack' AND enabled = 0
          RETURNING connection_id
        `
          if (rows[0] !== undefined) return 'enabled' as const
          const platform = yield* platformOf(connectionId)
          return platform === 'slack' ? ('already-enabled' as const) : ('missing' as const)
        }).pipe(Effect.mapError(writeError(connectionId))),

      disableConnection: (connectionId) =>
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
          UPDATE platform_connections SET enabled = 0, updated_at = CURRENT_TIMESTAMP
          WHERE connection_id = ${connectionId} AND platform = 'slack' AND enabled = 1
          RETURNING connection_id
        `
          if (rows[0] !== undefined) return 'disabled' as const
          const platform = yield* platformOf(connectionId)
          return platform === 'slack' ? ('already-disabled' as const) : ('missing' as const)
        }).pipe(Effect.mapError(writeError(connectionId))),

      setAccessPolicy: (connectionId, subject, policy) =>
        Effect.gen(function* () {
          const platform = yield* platformOf(connectionId)
          if (platform !== 'slack') return 'missing' as const
          const subjectType = subjectTypeFor(subject)
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const existingPolicies = yield* sql<Record<string, unknown>>`
                SELECT connection_id, subject_type, mode FROM platform_access_policies
                WHERE connection_id = ${connectionId} AND subject_type = ${subjectType}
                LIMIT 1
              `
              const existingSubjects = yield* sql<Record<string, unknown>>`
                SELECT connection_id, subject_type, platform_subject_id
                FROM platform_access_subjects
                WHERE connection_id = ${connectionId} AND subject_type = ${subjectType}
                ORDER BY platform_subject_id
              `
              const decodedPolicies = yield* decodeAccessRows(existingPolicies)
              const decodedSubjects = yield* decodeAccessSubjectRows(existingSubjects)
              const current = decodedPolicies[0]
              const currentIds = decodedSubjects.map((subject) => subject.platform_subject_id)
              const nextIds = [...policy.ids].toSorted()
              if (
                current?.mode === policy.mode &&
                currentIds.length === nextIds.length &&
                currentIds.every((id, index) => id === nextIds[index])
              ) {
                return 'unchanged' as const
              }
              yield* sql`
                INSERT INTO platform_access_policies (connection_id, subject_type, mode)
                VALUES (${connectionId}, ${subjectType}, ${policy.mode})
                ON CONFLICT (connection_id, subject_type)
                DO UPDATE SET mode = excluded.mode
              `
              yield* sql`
                DELETE FROM platform_access_subjects
                WHERE connection_id = ${connectionId} AND subject_type = ${subjectType}
              `
              for (const id of nextIds) {
                yield* sql`
                  INSERT INTO platform_access_subjects
                    (connection_id, subject_type, platform_subject_id)
                  VALUES (${connectionId}, ${subjectType}, ${id})
                `
              }
              return 'updated' as const
            }),
          )
        }).pipe(Effect.mapError(writeError(connectionId))),

      setChannel: (connectionId, channelId, patch) =>
        Effect.gen(function* () {
          const platform = yield* platformOf(connectionId)
          if (platform !== 'slack') return 'missing-connection' as const
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* sql<Record<string, unknown>>`
                SELECT connection_id, channel_id, invocation_mode, reply_mode
                FROM slack_channels
                WHERE connection_id = ${connectionId} AND channel_id = ${channelId}
                LIMIT 1
              `
              const decoded = yield* decodeSlackChannelRows(existing)
              const current = decoded[0]
              const nextInvocation = patch.invocationMode ?? current?.invocation_mode ?? null
              const nextReply = patch.replyMode ?? current?.reply_mode ?? null
              if (
                current !== undefined &&
                current.invocation_mode === nextInvocation &&
                current.reply_mode === nextReply
              ) {
                return 'unchanged' as const
              }
              yield* sql`
                INSERT INTO slack_channels
                  (connection_id, channel_id, invocation_mode, reply_mode)
                VALUES (${connectionId}, ${channelId}, ${nextInvocation}, ${nextReply})
                ON CONFLICT (connection_id, channel_id)
                DO UPDATE SET
                  invocation_mode = excluded.invocation_mode,
                  reply_mode = excluded.reply_mode
              `
              return 'updated' as const
            }),
          )
        }).pipe(Effect.mapError(writeError(connectionId))),

      resetChannel: (connectionId, channelId) =>
        Effect.gen(function* () {
          const deleted = yield* sql<Record<string, unknown>>`
            DELETE FROM slack_channels
            WHERE connection_id = ${connectionId} AND channel_id = ${channelId}
            RETURNING channel_id
          `.pipe(Effect.mapError(writeError(connectionId)))
          return deleted[0] === undefined ? ('missing' as const) : ('removed' as const)
        }).pipe(Effect.mapError(writeError(connectionId))),
    })
  }),
)
