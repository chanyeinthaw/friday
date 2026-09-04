/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL rows are decoded immediately through Effect Schema. */

import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { DiscordSnowflake } from './DiscordGuilds.ts'
import { runMigrations } from '../persistence/Migrations.ts'

/** The Ed25519 public key Discord publishes for an application: 64 hex digits. */
export const DiscordPublicKey = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[0-9a-fA-F]{64}$/)),
  Schema.brand('DiscordPublicKey'),
)
export type DiscordPublicKey = typeof DiscordPublicKey.Type

/** Name of the environment variable holding the bot token; the token itself is never stored. */
export const BotTokenEnvName = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  Schema.brand('BotTokenEnvName'),
)
export type BotTokenEnvName = typeof BotTokenEnvName.Type

export interface DiscordConnectionRecord {
  readonly connectionId: string
  readonly name: string
  readonly enabled: boolean
}

/** One stored Discord connection with its restart-pinned topology. */
export interface DiscordConnectionDetail {
  readonly connectionId: string
  readonly name: string
  readonly enabled: boolean
  readonly applicationId: string
  readonly publicKey: string
  readonly botTokenEnv: string
  readonly respondToGlobalMentions: boolean
  readonly activityDescription: boolean
}

/** Everything the add command persists. */
export interface DiscordConnectionInput {
  readonly connectionId: PlatformConnectionId
  readonly name: string
  readonly applicationId: DiscordSnowflake
  readonly publicKey: DiscordPublicKey
  readonly botTokenEnv: BotTokenEnvName
  readonly respondToGlobalMentions: boolean
}

export type DiscordConnectionAddOutcome = 'added' | 'connection-exists' | 'application-exists'
export type DiscordConnectionRemoveOutcome = 'removed' | 'missing'
export type DiscordConnectionEnableOutcome = 'enabled' | 'already-enabled' | 'missing'
export type DiscordConnectionDisableOutcome = 'disabled' | 'already-disabled' | 'missing'
export type DiscordConnectionUpdateOutcome =
  | 'updated'
  | 'unchanged'
  | 'application-exists'
  | 'missing'

/**
 * Partial update of one stored Discord connection; absent fields keep their
 * current value. The bot token stays indirected: only the environment
 * variable name is ever stored.
 */
export interface DiscordConnectionUpdate {
  readonly connectionId: PlatformConnectionId
  readonly name?: string
  readonly applicationId?: DiscordSnowflake
  readonly publicKey?: DiscordPublicKey
  readonly botTokenEnv?: BotTokenEnvName
  readonly respondToGlobalMentions?: boolean
}

export class DiscordConnectionError extends Schema.Error<DiscordConnectionError>(
  'DiscordConnectionError',
)({
  _tag: Schema.tag('DiscordConnectionError'),
  operation: Schema.Literals(['read', 'write', 'unknown-connection', 'non-discord-connection']),
  connectionId: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.connectionId === undefined
      ? `Discord connection ${this.operation} failed.`
      : `Discord connection ${this.operation} failed for ${this.connectionId}.`
  }
}

export interface DiscordConnectionsContract {
  /** Lists Discord connections in stable connection-id order. */
  readonly listConnections: () => Effect.Effect<
    ReadonlyArray<DiscordConnectionRecord>,
    DiscordConnectionError
  >
  /** Reads one connection's stored topology; `None` when not configured. */
  readonly getConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<Option.Option<DiscordConnectionDetail>, DiscordConnectionError>
  /**
   * Adds a Discord connection with safe defaults. Idempotent typed outcomes
   * report an existing connection id or an application ID already used by
   * another connection. The change requires a Friday restart to take effect.
   */
  readonly addConnection: (
    input: DiscordConnectionInput,
  ) => Effect.Effect<DiscordConnectionAddOutcome, DiscordConnectionError>
  /**
   * Removes a connection together with its Discord configuration (guilds,
   * channels, mention roles, access policies cascade). Idempotent.
   */
  readonly removeConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<DiscordConnectionRemoveOutcome, DiscordConnectionError>
  /** Enables a configured Discord connection; applies on restart. */
  readonly enableConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<DiscordConnectionEnableOutcome, DiscordConnectionError>
  /** Disables a configured Discord connection; applies on restart. */
  readonly disableConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<DiscordConnectionDisableOutcome, DiscordConnectionError>
  /**
   * Updates the stored fields of a configured Discord connection, preserving
   * every unspecified field. Idempotent: when all given fields already match,
   * reports `unchanged` without writing. Application IDs stay unique across
   * connections; any change requires a restart like the other lifecycle
   * operations.
   */
  readonly updateConnection: (
    update: DiscordConnectionUpdate,
  ) => Effect.Effect<DiscordConnectionUpdateOutcome, DiscordConnectionError>
}

export class DiscordConnections extends Context.Service<
  DiscordConnections,
  DiscordConnectionsContract
>()('friday/config/DiscordConnections') {}

const DiscordConnectionRow = Schema.Struct({
  connection_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Number,
  application_id: Schema.String,
  public_key: Schema.String,
  bot_token_env: Schema.String,
  respond_to_global_mentions: Schema.Number,
  activity_description_public: Schema.Number,
})
const decodeDiscordConnectionRows = Schema.decodeUnknownEffect(Schema.Array(DiscordConnectionRow))
const DiscordConnectionListRow = Schema.Struct({
  connection_id: Schema.String,
  name: Schema.String,
  enabled: Schema.Number,
})
const decodeDiscordConnectionListRows = Schema.decodeUnknownEffect(
  Schema.Array(DiscordConnectionListRow),
)
const PlatformRow = Schema.Struct({ platform: Schema.String })
const decodePlatformRows = Schema.decodeUnknownEffect(Schema.Array(PlatformRow))
const ApplicationOwnerRow = Schema.Struct({ connection_id: Schema.String })
const decodeApplicationOwnerRows = Schema.decodeUnknownEffect(Schema.Array(ApplicationOwnerRow))
const CurrentConnectionRow = Schema.Struct({
  name: Schema.String,
  application_id: Schema.String,
  public_key: Schema.String,
  bot_token_env: Schema.String,
  respond_to_global_mentions: Schema.Number,
})
const decodeCurrentConnectionRows = Schema.decodeUnknownEffect(Schema.Array(CurrentConnectionRow))

/**
 * Direct SQLite administration of Discord connection lifecycle. Like the other
 * config CLI services, these commands never use the control socket, so they
 * work while Friday is not running; connection topology is pinned to the
 * startup snapshot, so every lifecycle change requires a restart.
 */
export const DiscordConnectionsLive = Layer.effect(
  DiscordConnections,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // Ensure the database exists with current tables even before first start;
    // a migration failure here is a defect, not a per-command error.
    yield* runMigrations().pipe(Effect.orDie)

    const readError = (connectionId?: PlatformConnectionId) => (cause: unknown) =>
      new DiscordConnectionError({ operation: 'read', connectionId, cause })
    const writeError = (connectionId: PlatformConnectionId) => (cause: unknown) =>
      new DiscordConnectionError({ operation: 'write', connectionId, cause })

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

    /**
     * Connection lifecycle outcomes are idempotent, so every lifecycle
     * operation first resolves the stored platform; an unknown or non-Discord
     * connection id reports `missing` instead of failing.
     */

    return DiscordConnections.of({
      listConnections: () =>
        sql<Record<string, unknown>>`
          SELECT connection_id, name, enabled
          FROM platform_connections
          WHERE platform = 'discord'
          ORDER BY connection_id
        `.pipe(
          Effect.mapError(readError()),
          Effect.flatMap((rows) =>
            decodeDiscordConnectionListRows(rows).pipe(Effect.mapError(readError())),
          ),
          Effect.map((rows) =>
            rows.map((row) => ({
              connectionId: row.connection_id,
              name: row.name,
              enabled: row.enabled === 1,
            })),
          ),
        ),

      getConnection: (connectionId) =>
        sql<Record<string, unknown>>`
          SELECT
            platform_connections.connection_id,
            platform_connections.name,
            platform_connections.enabled,
            discord_connections.application_id,
            discord_connections.public_key,
            discord_connections.bot_token_env,
            discord_connections.respond_to_global_mentions,
            discord_connections.activity_description_public
          FROM platform_connections
          JOIN discord_connections USING (connection_id)
          WHERE platform_connections.connection_id = ${connectionId}
            AND platform_connections.platform = 'discord'
        `.pipe(
          Effect.mapError(readError(connectionId)),
          Effect.flatMap((rows) =>
            Effect.map(
              decodeDiscordConnectionRows(rows).pipe(Effect.mapError(readError(connectionId))),
              (decoded) =>
                Option.fromNullishOr(
                  (() => {
                    const row = decoded[0]
                    return row === undefined
                      ? undefined
                      : {
                          connectionId: row.connection_id,
                          name: row.name,
                          enabled: row.enabled === 1,
                          applicationId: row.application_id,
                          publicKey: row.public_key,
                          botTokenEnv: row.bot_token_env,
                          respondToGlobalMentions: row.respond_to_global_mentions === 1,
                          activityDescription: row.activity_description_public === 1,
                        }
                  })(),
                ),
            ),
          ),
        ),

      addConnection: (input) =>
        platformOf(input.connectionId).pipe(
          Effect.flatMap((platform) =>
            platform !== undefined
              ? Effect.succeed<DiscordConnectionAddOutcome>('connection-exists')
              : sql.withTransaction(
                  Effect.gen(function* () {
                    const applicationOwner = yield* sql<Record<string, unknown>>`
                      SELECT connection_id FROM discord_connections
                      WHERE application_id = ${input.applicationId}
                      LIMIT 1
                    `
                    if ((yield* decodeApplicationOwnerRows(applicationOwner))[0] !== undefined) {
                      return 'application-exists' as const
                    }
                    yield* sql`
                      INSERT INTO platform_connections (
                        connection_id, platform, name, enabled, created_at, updated_at
                      ) VALUES (
                        ${input.connectionId}, 'discord', ${input.name}, 1,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                      )
                    `
                    yield* sql`
                      INSERT INTO discord_connections (
                        connection_id, application_id, public_key, bot_token_env,
                        respond_to_global_mentions
                      ) VALUES (
                        ${input.connectionId}, ${input.applicationId}, ${input.publicKey},
                        ${input.botTokenEnv}, ${input.respondToGlobalMentions ? 1 : 0}
                      )
                    `
                    return 'added' as const
                  }),
                ),
          ),
          Effect.mapError(writeError(input.connectionId)),
        ),

      removeConnection: (connectionId) =>
        platformOf(connectionId).pipe(
          Effect.flatMap((platform) =>
            platform !== 'discord'
              ? Effect.succeed<DiscordConnectionRemoveOutcome>('missing')
              : sql
                  .withTransaction(
                    Effect.gen(function* () {
                      yield* sql`
                    DELETE FROM discord_connections WHERE connection_id = ${connectionId}
                  `
                      const deleted = yield* sql<Record<string, unknown>>`
                    DELETE FROM platform_connections
                    WHERE connection_id = ${connectionId} AND platform = 'discord'
                    RETURNING connection_id
                  `
                      const outcome: DiscordConnectionRemoveOutcome =
                        deleted[0] === undefined ? 'missing' : 'removed'
                      return outcome
                    }),
                  )
                  .pipe(Effect.mapError(writeError(connectionId))),
          ),
          Effect.mapError(writeError(connectionId)),
        ),

      updateConnection: (update) =>
        Effect.gen(function* () {
          const platform = yield* platformOf(update.connectionId)
          if (platform !== 'discord') return 'missing' as const
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<Record<string, unknown>>`
                  SELECT
                    platform_connections.name AS name,
                    discord_connections.application_id AS application_id,
                    discord_connections.public_key AS public_key,
                    discord_connections.bot_token_env AS bot_token_env,
                    discord_connections.respond_to_global_mentions
                      AS respond_to_global_mentions
                  FROM platform_connections
                  JOIN discord_connections USING (connection_id)
                  WHERE platform_connections.connection_id = ${update.connectionId}
                  LIMIT 1
                `
                const current = (yield* decodeCurrentConnectionRows(rows))[0]
                if (current === undefined) return 'missing' as const
                const nextName = update.name ?? current.name
                const nextApplicationId = update.applicationId ?? current.application_id
                const nextPublicKey = update.publicKey ?? current.public_key
                const nextBotTokenEnv = update.botTokenEnv ?? current.bot_token_env
                const nextRespondToGlobalMentions =
                  update.respondToGlobalMentions ?? current.respond_to_global_mentions === 1
                if (
                  nextName === current.name &&
                  nextApplicationId === current.application_id &&
                  nextPublicKey === current.public_key &&
                  nextBotTokenEnv === current.bot_token_env &&
                  nextRespondToGlobalMentions === (current.respond_to_global_mentions === 1)
                ) {
                  return 'unchanged' as const
                }
                if (nextApplicationId !== current.application_id) {
                  const owners = yield* sql<Record<string, unknown>>`
                    SELECT connection_id FROM discord_connections
                    WHERE application_id = ${nextApplicationId}
                      AND connection_id <> ${update.connectionId}
                    LIMIT 1
                  `
                  if ((yield* decodeApplicationOwnerRows(owners))[0] !== undefined) {
                    return 'application-exists' as const
                  }
                }
                yield* sql`
                  UPDATE platform_connections
                  SET name = ${nextName}, updated_at = CURRENT_TIMESTAMP
                  WHERE connection_id = ${update.connectionId}
                `
                yield* sql`
                  UPDATE discord_connections
                  SET application_id = ${nextApplicationId},
                    public_key = ${nextPublicKey},
                    bot_token_env = ${nextBotTokenEnv},
                    respond_to_global_mentions = ${nextRespondToGlobalMentions ? 1 : 0}
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
          WHERE connection_id = ${connectionId} AND platform = 'discord' AND enabled = 0
          RETURNING connection_id
        `.pipe(Effect.mapError(writeError(connectionId)))
          if (rows[0] !== undefined) return 'enabled' as const
          const platform = yield* platformOf(connectionId).pipe(
            Effect.mapError(writeError(connectionId)),
          )
          return platform === 'discord' ? ('already-enabled' as const) : ('missing' as const)
        }),

      disableConnection: (connectionId) =>
        Effect.gen(function* () {
          const rows = yield* sql<Record<string, unknown>>`
          UPDATE platform_connections SET enabled = 0, updated_at = CURRENT_TIMESTAMP
          WHERE connection_id = ${connectionId} AND platform = 'discord' AND enabled = 1
          RETURNING connection_id
        `.pipe(Effect.mapError(writeError(connectionId)))
          if (rows[0] !== undefined) return 'disabled' as const
          const platform = yield* platformOf(connectionId).pipe(
            Effect.mapError(writeError(connectionId)),
          )
          return platform === 'discord' ? ('already-disabled' as const) : ('missing' as const)
        }),
    })
  }),
)
