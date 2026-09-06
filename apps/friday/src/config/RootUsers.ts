/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL result rows are not consumed; the statement result is discarded. */

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../persistence/Migrations.ts'

const NonEmptyTrimmed = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

/**
 * Platforms that support a guild/workspace scope. Discord guild IDs and Slack
 * workspace IDs share the `scopeId` field.
 */
export const RootUserPlatform = Schema.Literals(['discord', 'slack'])
export type RootUserPlatform = typeof RootUserPlatform.Type

export const RootUserScopeId = NonEmptyTrimmed.pipe(Schema.brand('RootUserScopeId'))
export type RootUserScopeId = typeof RootUserScopeId.Type

export const RootUserId = NonEmptyTrimmed.pipe(Schema.brand('RootUserId'))
export type RootUserId = typeof RootUserId.Type

/** One root-user identity for a single platform plus guild/workspace scope. */
export const RootUser = Schema.Struct({
  platform: RootUserPlatform,
  scopeId: RootUserScopeId,
  userId: RootUserId,
})
export interface RootUser extends Schema.Schema.Type<typeof RootUser> {}

export class RootUserError extends Schema.Error<RootUserError>('RootUserError')({
  _tag: Schema.tag('RootUserError'),
  operation: Schema.Literals(['add', 'remove', 'list']),
  platform: Schema.optional(Schema.String),
  scopeId: Schema.optional(Schema.String),
  userId: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Root user ${this.operation} failed.`
  }
}

/** Outcome of the idempotent add operation. */
export type RootUserAddOutcome = 'added' | 'exists'
/** Outcome of the idempotent remove operation. */
export type RootUserRemoveOutcome = 'removed' | 'missing'

export interface RootUsersContract {
  /**
   * Adds one root-user identity to the persistent registry. Reports `exists`
   * when the platform plus guild/workspace plus user is already configured.
   * The running process reads the registry live, so no restart is needed.
   */
  readonly add: (rootUser: RootUser) => Effect.Effect<RootUserAddOutcome, RootUserError>
  /**
   * Removes one root-user identity. Reports `missing` when it is not configured.
   */
  readonly remove: (rootUser: RootUser) => Effect.Effect<RootUserRemoveOutcome, RootUserError>
  /** Lists all configured root-user identities in stable sorted order. */
  readonly list: () => Effect.Effect<ReadonlyArray<RootUser>, RootUserError>
}

export class RootUsers extends Context.Service<RootUsers, RootUsersContract>()(
  'friday/config/RootUsers',
) {}

const RootUserRow = Schema.Struct({
  platform: Schema.String,
  scope_id: Schema.String,
  user_id: Schema.String,
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(RootUserRow))
const decodeRootUser = Schema.decodeUnknownEffect(RootUser)

/**
 * Direct SQLite administration of the root-user registry. Deliberately does
 * not use the control socket: these commands must work while Friday is not
 * running, and the running process reads the registry live on every prompt
 * render.
 */
export const RootUsersLive = Layer.effect(
  RootUsers,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // Ensure the database exists with current tables even before first start.
    yield* runMigrations()
    return RootUsers.of({
      // RETURNING yields a row exactly when this statement inserted the root user;
      // a conflicting existing row is ignored and reports `exists`.
      add: (rootUser) =>
        sql<Record<string, unknown>>`
          INSERT INTO root_users (platform, scope_id, user_id, created_at)
          VALUES (${rootUser.platform}, ${rootUser.scopeId}, ${rootUser.userId}, CURRENT_TIMESTAMP)
          ON CONFLICT (platform, scope_id, user_id) DO NOTHING
          RETURNING platform
        `.pipe(
          Effect.map((rows): RootUserAddOutcome => (rows[0] === undefined ? 'exists' : 'added')),
          Effect.mapError(
            (cause) =>
              new RootUserError({
                operation: 'add',
                platform: rootUser.platform,
                scopeId: rootUser.scopeId,
                userId: rootUser.userId,
                cause,
              }),
          ),
        ),
      // RETURNING yields a row exactly when this statement deleted the root user.
      remove: (rootUser) =>
        sql<Record<string, unknown>>`
          DELETE FROM root_users
          WHERE platform = ${rootUser.platform}
            AND scope_id = ${rootUser.scopeId}
            AND user_id = ${rootUser.userId}
          RETURNING platform
        `.pipe(
          Effect.map((rows): RootUserRemoveOutcome =>
            rows[0] === undefined ? 'missing' : 'removed',
          ),
          Effect.mapError(
            (cause) =>
              new RootUserError({
                operation: 'remove',
                platform: rootUser.platform,
                scopeId: rootUser.scopeId,
                userId: rootUser.userId,
                cause,
              }),
          ),
        ),
      list: () =>
        sql<Record<string, unknown>>`
          SELECT platform, scope_id, user_id FROM root_users
          ORDER BY platform, scope_id, user_id
        `.pipe(
          Effect.flatMap((rows) =>
            decodeRows(rows).pipe(
              Effect.flatMap((decoded) =>
                Effect.forEach(decoded, (row) =>
                  decodeRootUser({
                    platform: row.platform,
                    scopeId: row.scope_id,
                    userId: row.user_id,
                  }),
                ),
              ),
            ),
          ),
          Effect.mapError((cause) => new RootUserError({ operation: 'list', cause })),
        ),
    })
  }),
)
