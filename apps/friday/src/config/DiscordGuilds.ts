/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL rows are decoded immediately through Effect Schema. */

import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  DiscordGuildConfig,
  InvocationMode,
  ReplyMode,
  type AccessPolicy,
  type DiscordGuildChannelConfig,
} from './AppConfig.ts'
import {
  migrateConnectionScopedDiscordConfig,
  runStructuralMigrations,
} from '../persistence/Migrations.ts'

/**
 * A stable Discord snowflake: the decimal form of a positive 64-bit integer,
 * currently 17-20 digits with no leading zero. Guild, channel, and user IDs
 * share the format.
 */
export const DiscordSnowflake = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[1-9][0-9]{16,19}$/)),
)
export type DiscordSnowflake = typeof DiscordSnowflake.Type

export const DiscordGuildId = DiscordSnowflake.pipe(Schema.brand('DiscordGuildId'))
export type DiscordGuildId = typeof DiscordGuildId.Type

export const DiscordGuildChannelId = DiscordSnowflake.pipe(Schema.brand('DiscordGuildChannelId'))
export type DiscordGuildChannelId = typeof DiscordGuildChannelId.Type

export class DiscordGuildError extends Schema.Error<DiscordGuildError>('DiscordGuildError')({
  _tag: Schema.tag('DiscordGuildError'),
  operation: Schema.Literals(['read', 'write', 'unknown-connection', 'non-discord-connection']),
  connectionId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.connectionId === undefined
      ? `Discord guild configuration ${this.operation} failed.`
      : `Discord guild configuration ${this.operation} failed for ${this.connectionId}.`
  }
}

export type DiscordGuildEnableOutcome = 'enabled' | 'already-enabled'
export type DiscordGuildDisableOutcome = 'disabled' | 'already-disabled' | 'missing'
export type DiscordGuildRemoveOutcome = 'removed' | 'missing'
export type DiscordGuildUpdateOutcome = 'updated' | 'unchanged' | 'missing'
export type DiscordGuildChannelUpdateOutcome = 'updated' | 'unchanged' | 'missing-guild'
export type DiscordGuildChannelResetOutcome = 'removed' | 'missing'

/** One channel override to apply; absent fields keep their current value. */
export interface DiscordGuildChannelPatch {
  readonly invocationMode?: InvocationMode
  readonly users?: AccessPolicy
  readonly replyMode?: ReplyMode
}

export interface DiscordGuildsContract {
  /** Lists a connection's guild configuration in stable guild-id order. */
  readonly listGuilds: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<ReadonlyArray<DiscordGuildConfig>, DiscordGuildError>
  /**
   * Enables a guild, creating its configuration with defaults when absent.
   * Idempotent.
   */
  readonly enableGuild: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
  ) => Effect.Effect<DiscordGuildEnableOutcome, DiscordGuildError>
  /** Disables a guild. Reports `missing` instead of failing when unconfigured. */
  readonly disableGuild: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
  ) => Effect.Effect<DiscordGuildDisableOutcome, DiscordGuildError>
  /** Removes a guild's configuration together with its channel overrides. */
  readonly removeGuild: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
  ) => Effect.Effect<DiscordGuildRemoveOutcome, DiscordGuildError>
  /** Sets the guild-wide invocation default. */
  readonly setGuildInvocation: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    mode: InvocationMode,
  ) => Effect.Effect<DiscordGuildUpdateOutcome, DiscordGuildError>
  /** Replaces the guild-wide user permission default. */
  readonly setGuildUsers: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    policy: AccessPolicy,
  ) => Effect.Effect<DiscordGuildUpdateOutcome, DiscordGuildError>
  /** Replaces the guild-wide channel scope: which channels admit Friday at all. */
  readonly setGuildChannelScope: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    policy: AccessPolicy,
  ) => Effect.Effect<DiscordGuildUpdateOutcome, DiscordGuildError>
  /**
   * Upserts one channel override. Absent patch fields keep their current
   * value, so a row only carries the overrides it needs.
   */
  readonly setChannel: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    channelId: DiscordGuildChannelId,
    patch: DiscordGuildChannelPatch,
  ) => Effect.Effect<DiscordGuildChannelUpdateOutcome, DiscordGuildError>
  /** Removes one channel override, restoring guild defaults for the channel. */
  readonly resetChannel: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    channelId: DiscordGuildChannelId,
  ) => Effect.Effect<DiscordGuildChannelResetOutcome, DiscordGuildError>
}

export class DiscordGuilds extends Context.Service<DiscordGuilds, DiscordGuildsContract>()(
  'friday/config/DiscordGuilds',
) {}

/** Mutable assembly shapes mirroring the optional-field config schema. */
interface AssembledDiscordGuild {
  guildId: string
  enabled: boolean
  invocation: { defaultMode: InvocationMode }
  users?: AccessPolicy
  channelScope?: AccessPolicy
  channels: ReadonlyArray<DiscordGuildChannelConfig>
}

interface AssembledDiscordGuildChannel {
  channelId: string
  invocationMode?: InvocationMode
  users?: AccessPolicy
  replyMode?: ReplyMode
}

const GuildRow = Schema.Struct({
  guild_id: Schema.String,
  enabled: Schema.Number,
  invocation_mode: InvocationMode,
  users_mode: Schema.NullOr(Schema.Literals(['all', 'allow', 'deny'])),
  channels_mode: Schema.NullOr(Schema.Literals(['all', 'allow', 'deny'])),
})
const GuildUserRow = Schema.Struct({ guild_id: Schema.String, user_id: Schema.String })
const GuildChannelScopeRow = Schema.Struct({ guild_id: Schema.String, channel_id: Schema.String })
const GuildChannelRow = Schema.Struct({
  guild_id: Schema.String,
  channel_id: Schema.String,
  invocation_mode: Schema.NullOr(InvocationMode),
  users_mode: Schema.NullOr(Schema.Literals(['all', 'allow', 'deny'])),
  reply_mode: Schema.NullOr(ReplyMode),
})
const GuildChannelUserRow = Schema.Struct({
  guild_id: Schema.String,
  channel_id: Schema.String,
  user_id: Schema.String,
})
const CurrentInvocationRow = Schema.Struct({ invocation_mode: InvocationMode })
const CurrentPolicyRow = Schema.Struct({
  policy_mode: Schema.NullOr(Schema.Literals(['all', 'allow', 'deny'])),
})
const CurrentSubjectRow = Schema.Struct({ subject_id: Schema.String })
const CurrentChannelRow = Schema.Struct({
  invocation_mode: Schema.NullOr(InvocationMode),
  users_mode: Schema.NullOr(Schema.Literals(['all', 'allow', 'deny'])),
  reply_mode: Schema.NullOr(ReplyMode),
})
const ConnectionRow = Schema.Struct({ platform: Schema.String })
const decodeGuildRows = Schema.decodeUnknownEffect(Schema.Array(GuildRow))
const decodeGuildUserRows = Schema.decodeUnknownEffect(Schema.Array(GuildUserRow))
const decodeGuildChannelScopeRows = Schema.decodeUnknownEffect(Schema.Array(GuildChannelScopeRow))
const decodeGuildChannelRows = Schema.decodeUnknownEffect(Schema.Array(GuildChannelRow))
const decodeGuildChannelUserRows = Schema.decodeUnknownEffect(Schema.Array(GuildChannelUserRow))
const decodeCurrentInvocationRows = Schema.decodeUnknownEffect(Schema.Array(CurrentInvocationRow))
const decodeCurrentPolicyRows = Schema.decodeUnknownEffect(Schema.Array(CurrentPolicyRow))
const decodeCurrentSubjectRows = Schema.decodeUnknownEffect(Schema.Array(CurrentSubjectRow))
const decodeCurrentChannelRows = Schema.decodeUnknownEffect(Schema.Array(CurrentChannelRow))
const decodeConnectionRows = Schema.decodeUnknownEffect(Schema.Array(ConnectionRow))

const normalizeSubjects = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(ids)].toSorted()

const sameSubjects = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index])

const normalizePolicy = (policy: AccessPolicy): AccessPolicy => ({
  mode: policy.mode,
  ids: normalizeSubjects(policy.ids),
})

const channelUpdateIsUnchanged = (
  current: typeof CurrentChannelRow.Type | undefined,
  invocationMode: InvocationMode | null,
  usersMode: AccessPolicy['mode'] | null,
  replyMode: ReplyMode | null,
  currentUsers: ReadonlyArray<string>,
  normalizedUsers: AccessPolicy | undefined,
): boolean =>
  current !== undefined &&
  current.invocation_mode === invocationMode &&
  current.users_mode === usersMode &&
  current.reply_mode === replyMode &&
  (normalizedUsers === undefined || sameSubjects(currentUsers, normalizedUsers.ids))

/**
 * Direct SQLite administration of Discord guild configuration. The store stays
 * independent of the running process, so the CLI can write while Friday is
 * offline. The CLI requests a control-socket reload only after a successful
 * mutation returns from this layer.
 */
export const DiscordGuildsLive = Layer.effect(
  DiscordGuilds,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // Structural migrations must always succeed; a failure there is a defect.
    // A refused legacy Discord migration, however, must not brick the config
    // CLI: recording guild configuration is exactly how operators resolve the
    // refusal (recorded channel overrides supersede their legacy rows), so the
    // typed refusal is tolerated here while Friday's startup stays fail-closed.
    yield* runStructuralMigrations().pipe(Effect.orDie)
    yield* migrateConnectionScopedDiscordConfig().pipe(
      Effect.catchTag('LegacyDiscordConfigMigrationError', () => Effect.void),
      Effect.orDie,
    )

    const writeError = (connectionId: PlatformConnectionId) => (cause: unknown) =>
      new DiscordGuildError({ operation: 'write', connectionId, cause })
    const readError = (connectionId?: PlatformConnectionId) => (cause: unknown) =>
      new DiscordGuildError({ operation: 'read', connectionId, cause })

    /**
     * Validates that the connection exists and is a Discord connection before
     * any write touches the guild tables.
     */
    const requireDiscordConnection = (connectionId: PlatformConnectionId) =>
      Effect.gen(function* () {
        const rows = yield* sql<Record<string, unknown>>`
        SELECT platform
        FROM platform_connections
        WHERE connection_id = ${connectionId}
        LIMIT 1
      `.pipe(Effect.mapError(readError(connectionId)))
        const platform = (yield* decodeConnectionRows(rows).pipe(
          Effect.mapError(readError(connectionId)),
        ))[0]?.platform
        if (platform === 'discord') return
        return yield* new DiscordGuildError({
          operation: platform === undefined ? 'unknown-connection' : 'non-discord-connection',
          connectionId,
          cause: platform === undefined ? undefined : new Error(`Platform: ${platform}`),
        })
      })

    const guildExists = (connectionId: PlatformConnectionId, guildId: string) =>
      sql<Record<string, unknown>>`
        SELECT guild_id FROM discord_guilds
        WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
        LIMIT 1
      `.pipe(
        Effect.mapError(readError(connectionId)),
        Effect.map((rows) => rows.length > 0),
      )

    const assembleGuilds = (
      guildRows: ReadonlyArray<typeof GuildRow.Type>,
      userRows: ReadonlyArray<typeof GuildUserRow.Type>,
      channelScopeRows: ReadonlyArray<typeof GuildChannelScopeRow.Type>,
      channelRows: ReadonlyArray<typeof GuildChannelRow.Type>,
      channelUserRows: ReadonlyArray<typeof GuildChannelUserRow.Type>,
    ): ReadonlyArray<DiscordGuildConfig> =>
      guildRows.map((guild) => {
        // Optional policy sections attach only when configured, mirroring the
        // config schema's inheritance-when-absent semantics.
        const guildEntry: AssembledDiscordGuild = {
          guildId: guild.guild_id,
          enabled: guild.enabled === 1,
          invocation: { defaultMode: guild.invocation_mode },
          channels: channelRows
            .filter((channel) => channel.guild_id === guild.guild_id)
            .map((channel) => {
              const channelEntry: AssembledDiscordGuildChannel = {
                channelId: channel.channel_id,
              }
              if (channel.invocation_mode !== null) {
                channelEntry.invocationMode = channel.invocation_mode
              }
              if (channel.users_mode !== null) {
                channelEntry.users = {
                  mode: channel.users_mode,
                  ids: channelUserRows
                    .filter(
                      (subject) =>
                        subject.guild_id === channel.guild_id &&
                        subject.channel_id === channel.channel_id,
                    )
                    .map((subject) => subject.user_id),
                }
              }
              if (channel.reply_mode !== null) {
                channelEntry.replyMode = channel.reply_mode
              }
              return channelEntry
            }),
        }
        if (guild.users_mode !== null) {
          guildEntry.users = {
            mode: guild.users_mode,
            ids: userRows
              .filter((subject) => subject.guild_id === guild.guild_id)
              .map((subject) => subject.user_id),
          }
        }
        if (guild.channels_mode !== null) {
          guildEntry.channelScope = {
            mode: guild.channels_mode,
            ids: channelScopeRows
              .filter((subject) => subject.guild_id === guild.guild_id)
              .map((subject) => subject.channel_id),
          }
        }
        return guildEntry
      })

    /** Replaces the user subject rows of a guild or channel allow/deny policy. */
    const replaceUserSubjects = (
      connectionId: PlatformConnectionId,
      scope: { readonly guildId: string; readonly channelId?: string },
      policy: AccessPolicy,
    ) =>
      Effect.gen(function* () {
        yield* (
          scope.channelId === undefined
            ? sql`
              DELETE FROM discord_guild_users
              WHERE connection_id = ${connectionId} AND guild_id = ${scope.guildId}
            `
            : sql`
              DELETE FROM discord_guild_channel_users
              WHERE connection_id = ${connectionId}
                AND guild_id = ${scope.guildId}
                AND channel_id = ${scope.channelId}
            `
        ).pipe(Effect.mapError(writeError(connectionId)))
        yield* Effect.forEach(
          policy.ids,
          (userId) =>
            (scope.channelId === undefined
              ? sql`
                INSERT INTO discord_guild_users (connection_id, guild_id, user_id)
                VALUES (${connectionId}, ${scope.guildId}, ${userId})
              `
              : sql`
                INSERT INTO discord_guild_channel_users (connection_id, guild_id, channel_id, user_id)
                VALUES (${connectionId}, ${scope.guildId}, ${scope.channelId}, ${userId})
              `
            ).pipe(Effect.mapError(writeError(connectionId))),
          { discard: true },
        )
      })

    /** Replaces the channel-id subject rows of a guild channel scope policy. */
    const replaceScopeSubjects = (
      connectionId: PlatformConnectionId,
      guildId: string,
      policy: AccessPolicy,
    ) =>
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM discord_guild_channel_scope
          WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
        `.pipe(Effect.mapError(writeError(connectionId)))
        yield* Effect.forEach(
          policy.ids,
          (channelId) =>
            sql`
              INSERT INTO discord_guild_channel_scope (connection_id, guild_id, channel_id)
              VALUES (${connectionId}, ${guildId}, ${channelId})
            `.pipe(Effect.mapError(writeError(connectionId))),
          { discard: true },
        )
      })

    const updateChannel = Effect.fn('DiscordGuilds.updateChannel')(function* (
      connectionId: PlatformConnectionId,
      guildId: DiscordGuildId,
      channelId: DiscordGuildChannelId,
      patch: DiscordGuildChannelPatch,
    ) {
      if (!(yield* guildExists(connectionId, guildId))) return 'missing-guild' as const
      const currentRows = yield* sql<Record<string, unknown>>`
        SELECT invocation_mode, users_mode, reply_mode
        FROM discord_guild_channels
        WHERE connection_id = ${connectionId}
          AND guild_id = ${guildId}
          AND channel_id = ${channelId}
        LIMIT 1
      `.pipe(Effect.mapError(readError(connectionId)))
      const current = (yield* decodeCurrentChannelRows(currentRows).pipe(
        Effect.mapError(readError(connectionId)),
      ))[0]
      const normalizedUsers = patch.users === undefined ? undefined : normalizePolicy(patch.users)
      const invocationMode = patch.invocationMode ?? current?.invocation_mode ?? null
      const usersMode = normalizedUsers?.mode ?? current?.users_mode ?? null
      const replyMode = patch.replyMode ?? current?.reply_mode ?? null
      const currentUserRows =
        normalizedUsers === undefined
          ? []
          : yield* sql<Record<string, unknown>>`
              SELECT user_id AS subject_id
              FROM discord_guild_channel_users
              WHERE connection_id = ${connectionId}
                AND guild_id = ${guildId}
                AND channel_id = ${channelId}
              ORDER BY user_id
            `.pipe(Effect.mapError(readError(connectionId)))
      const currentUsers = (yield* decodeCurrentSubjectRows(currentUserRows).pipe(
        Effect.mapError(readError(connectionId)),
      )).map((row) => row.subject_id)
      if (
        channelUpdateIsUnchanged(
          current,
          invocationMode,
          usersMode,
          replyMode,
          currentUsers,
          normalizedUsers,
        )
      ) {
        return 'unchanged' as const
      }
      yield* sql`
        INSERT INTO discord_guild_channels
          (connection_id, guild_id, channel_id, invocation_mode, users_mode, reply_mode)
        VALUES (${connectionId}, ${guildId}, ${channelId}, ${invocationMode}, ${usersMode}, ${replyMode})
        ON CONFLICT (connection_id, guild_id, channel_id) DO UPDATE SET
          invocation_mode = excluded.invocation_mode,
          users_mode = excluded.users_mode,
          reply_mode = excluded.reply_mode
      `.pipe(Effect.mapError(writeError(connectionId)))
      if (normalizedUsers !== undefined) {
        yield* replaceUserSubjects(connectionId, { guildId, channelId }, normalizedUsers)
      }
      return 'updated' as const
    })

    return DiscordGuilds.of({
      listGuilds: (connectionId) =>
        Effect.gen(function* () {
          const guildRows = yield* sql<Record<string, unknown>>`
            SELECT guild_id, enabled, invocation_mode, users_mode, channels_mode
            FROM discord_guilds
            WHERE connection_id = ${connectionId}
            ORDER BY guild_id
          `.pipe(Effect.mapError(readError(connectionId)))
          const userRows = yield* sql<Record<string, unknown>>`
            SELECT guild_id, user_id FROM discord_guild_users
            WHERE connection_id = ${connectionId}
            ORDER BY guild_id, user_id
          `.pipe(Effect.mapError(readError(connectionId)))
          const channelScopeRows = yield* sql<Record<string, unknown>>`
            SELECT guild_id, channel_id FROM discord_guild_channel_scope
            WHERE connection_id = ${connectionId}
            ORDER BY guild_id, channel_id
          `.pipe(Effect.mapError(readError(connectionId)))
          const channelRows = yield* sql<Record<string, unknown>>`
            SELECT guild_id, channel_id, invocation_mode, users_mode, reply_mode
            FROM discord_guild_channels
            WHERE connection_id = ${connectionId}
            ORDER BY guild_id, channel_id
          `.pipe(Effect.mapError(readError(connectionId)))
          const channelUserRows = yield* sql<Record<string, unknown>>`
            SELECT guild_id, channel_id, user_id FROM discord_guild_channel_users
            WHERE connection_id = ${connectionId}
            ORDER BY guild_id, channel_id, user_id
          `.pipe(Effect.mapError(readError(connectionId)))
          return assembleGuilds(
            yield* decodeGuildRows(guildRows).pipe(Effect.mapError(readError(connectionId))),
            yield* decodeGuildUserRows(userRows).pipe(Effect.mapError(readError(connectionId))),
            yield* decodeGuildChannelScopeRows(channelScopeRows).pipe(
              Effect.mapError(readError(connectionId)),
            ),
            yield* decodeGuildChannelRows(channelRows).pipe(
              Effect.mapError(readError(connectionId)),
            ),
            yield* decodeGuildChannelUserRows(channelUserRows).pipe(
              Effect.mapError(readError(connectionId)),
            ),
          )
        }),

      enableGuild: (connectionId, guildId) =>
        Effect.gen(function* () {
          yield* requireDiscordConnection(connectionId)
          // Re-enable a disabled configuration before considering a fresh insert.
          const reEnabled = yield* sql<Record<string, unknown>>`
            UPDATE discord_guilds SET enabled = 1
            WHERE connection_id = ${connectionId} AND guild_id = ${guildId} AND enabled = 0
            RETURNING guild_id
          `.pipe(Effect.mapError(writeError(connectionId)))
          if (reEnabled[0] !== undefined) return 'enabled' as const
          const inserted = yield* sql<Record<string, unknown>>`
            INSERT INTO discord_guilds (connection_id, guild_id, enabled, invocation_mode, users_mode)
            VALUES (${connectionId}, ${guildId}, 1, 'mention-only', NULL)
            ON CONFLICT (connection_id, guild_id) DO NOTHING
            RETURNING guild_id
          `.pipe(Effect.mapError(writeError(connectionId)))
          return inserted[0] === undefined ? ('already-enabled' as const) : ('enabled' as const)
        }),

      disableGuild: (connectionId, guildId) =>
        Effect.gen(function* () {
          yield* requireDiscordConnection(connectionId)
          const rows = yield* sql<Record<string, unknown>>`
            UPDATE discord_guilds SET enabled = 0
            WHERE connection_id = ${connectionId} AND guild_id = ${guildId} AND enabled = 1
            RETURNING guild_id
          `.pipe(Effect.mapError(writeError(connectionId)))
          if (rows[0] !== undefined) return 'disabled' as const
          const exists = yield* guildExists(connectionId, guildId)
          return exists ? ('already-disabled' as const) : ('missing' as const)
        }),

      removeGuild: (connectionId, guildId) =>
        requireDiscordConnection(connectionId).pipe(
          Effect.andThen(
            sql<Record<string, unknown>>`
          DELETE FROM discord_guilds
          WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
          RETURNING guild_id
        `.pipe(
              Effect.mapError(writeError(connectionId)),
              Effect.map((rows): DiscordGuildRemoveOutcome =>
                rows[0] === undefined ? 'missing' : 'removed',
              ),
            ),
          ),
        ),

      setGuildInvocation: (connectionId, guildId, mode) =>
        requireDiscordConnection(connectionId).pipe(
          Effect.andThen(
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const rows = yield* sql<Record<string, unknown>>`
                    SELECT invocation_mode
                    FROM discord_guilds
                    WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
                    LIMIT 1
                  `.pipe(Effect.mapError(readError(connectionId)))
                  const current = (yield* decodeCurrentInvocationRows(rows).pipe(
                    Effect.mapError(readError(connectionId)),
                  ))[0]
                  if (current === undefined) return 'missing' as const
                  if (current.invocation_mode === mode) return 'unchanged' as const
                  yield* sql`
                    UPDATE discord_guilds SET invocation_mode = ${mode}
                    WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
                  `.pipe(Effect.mapError(writeError(connectionId)))
                  return 'updated' as const
                }),
              )
              .pipe(Effect.mapError(writeError(connectionId))),
          ),
        ),

      setGuildUsers: (connectionId, guildId, policy) =>
        requireDiscordConnection(connectionId).pipe(
          Effect.andThen(
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const normalized = normalizePolicy(policy)
                  const rows = yield* sql<Record<string, unknown>>`
                    SELECT users_mode AS policy_mode
                    FROM discord_guilds
                    WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
                    LIMIT 1
                  `.pipe(Effect.mapError(readError(connectionId)))
                  const current = (yield* decodeCurrentPolicyRows(rows).pipe(
                    Effect.mapError(readError(connectionId)),
                  ))[0]
                  if (current === undefined) return 'missing' as const
                  const subjectRows = yield* sql<Record<string, unknown>>`
                    SELECT user_id AS subject_id
                    FROM discord_guild_users
                    WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
                    ORDER BY user_id
                  `.pipe(Effect.mapError(readError(connectionId)))
                  const currentSubjects = (yield* decodeCurrentSubjectRows(subjectRows).pipe(
                    Effect.mapError(readError(connectionId)),
                  )).map((row) => row.subject_id)
                  if (
                    current.policy_mode === normalized.mode &&
                    sameSubjects(currentSubjects, normalized.ids)
                  ) {
                    return 'unchanged' as const
                  }
                  yield* sql`
                    UPDATE discord_guilds SET users_mode = ${normalized.mode}
                    WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
                  `.pipe(Effect.mapError(writeError(connectionId)))
                  yield* replaceUserSubjects(connectionId, { guildId }, normalized)
                  return 'updated' as const
                }),
              )
              .pipe(Effect.mapError(writeError(connectionId))),
          ),
        ),

      setGuildChannelScope: (connectionId, guildId, policy) =>
        requireDiscordConnection(connectionId).pipe(
          Effect.andThen(
            sql
              .withTransaction(
                Effect.gen(function* () {
                  const normalized = normalizePolicy(policy)
                  const rows = yield* sql<Record<string, unknown>>`
                    SELECT channels_mode AS policy_mode
                    FROM discord_guilds
                    WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
                    LIMIT 1
                  `.pipe(Effect.mapError(readError(connectionId)))
                  const current = (yield* decodeCurrentPolicyRows(rows).pipe(
                    Effect.mapError(readError(connectionId)),
                  ))[0]
                  if (current === undefined) return 'missing' as const
                  const subjectRows = yield* sql<Record<string, unknown>>`
                    SELECT channel_id AS subject_id
                    FROM discord_guild_channel_scope
                    WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
                    ORDER BY channel_id
                  `.pipe(Effect.mapError(readError(connectionId)))
                  const currentSubjects = (yield* decodeCurrentSubjectRows(subjectRows).pipe(
                    Effect.mapError(readError(connectionId)),
                  )).map((row) => row.subject_id)
                  if (
                    current.policy_mode === normalized.mode &&
                    sameSubjects(currentSubjects, normalized.ids)
                  ) {
                    return 'unchanged' as const
                  }
                  yield* sql`
                    UPDATE discord_guilds SET channels_mode = ${normalized.mode}
                    WHERE connection_id = ${connectionId} AND guild_id = ${guildId}
                  `.pipe(Effect.mapError(writeError(connectionId)))
                  yield* replaceScopeSubjects(connectionId, guildId, normalized)
                  return 'updated' as const
                }),
              )
              .pipe(Effect.mapError(writeError(connectionId))),
          ),
        ),

      setChannel: (connectionId, guildId, channelId, patch) =>
        requireDiscordConnection(connectionId).pipe(
          Effect.andThen(
            sql
              .withTransaction(updateChannel(connectionId, guildId, channelId, patch))
              .pipe(Effect.mapError(writeError(connectionId))),
          ),
        ),

      resetChannel: (connectionId, guildId, channelId) =>
        requireDiscordConnection(connectionId).pipe(
          Effect.andThen(
            sql<Record<string, unknown>>`
          DELETE FROM discord_guild_channels
          WHERE connection_id = ${connectionId}
            AND guild_id = ${guildId}
            AND channel_id = ${channelId}
          RETURNING channel_id
        `.pipe(
              Effect.mapError(writeError(connectionId)),
              Effect.map((rows): DiscordGuildChannelResetOutcome =>
                rows[0] === undefined ? 'missing' : 'removed',
              ),
            ),
          ),
        ),
    })
  }),
)
