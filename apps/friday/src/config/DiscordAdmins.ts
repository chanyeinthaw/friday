/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL result rows are not consumed; the statement result is discarded. */

import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runMigrations } from '../persistence/Migrations.ts'

/**
 * A stable Discord user ID (snowflake): the decimal form of a positive 64-bit
 * integer, currently 17-20 digits with no leading zero.
 */
export const DiscordUserId = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[1-9][0-9]{16,19}$/)),
  Schema.brand('DiscordUserId'),
)
export type DiscordUserId = typeof DiscordUserId.Type

export class DiscordAdminError extends Schema.Error<DiscordAdminError>('DiscordAdminError')({
  _tag: Schema.tag('DiscordAdminError'),
  operation: Schema.Literals(['add', 'remove', 'list']),
  userId: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.userId === undefined
      ? `Discord administrator ${this.operation} failed.`
      : `Discord administrator ${this.operation} failed for ${this.userId}.`
  }
}

/** Outcome of the idempotent add operation. */
export type DiscordAdminAddOutcome = 'added' | 'exists'
/** Outcome of the idempotent remove operation. */
export type DiscordAdminRemoveOutcome = 'removed' | 'missing'

export interface DiscordAdminsContract {
  /**
   * Adds a user to the persistent `admin_discord_users` allow-list. Reports
   * `exists` when the user is already configured instead of failing. The
   * running process reads the allow-list at startup only, so the change
   * requires a Friday restart.
   */
  readonly add: (userId: DiscordUserId) => Effect.Effect<DiscordAdminAddOutcome, DiscordAdminError>
  /**
   * Removes a user from the persistent allow-list. Reports `missing` when the
   * user is not configured instead of failing. The change requires a Friday
   * restart.
   */
  readonly remove: (
    userId: DiscordUserId,
  ) => Effect.Effect<DiscordAdminRemoveOutcome, DiscordAdminError>
  /** Lists the configured administrator user IDs in stable sorted order. */
  readonly list: () => Effect.Effect<ReadonlyArray<string>, DiscordAdminError>
}

export class DiscordAdmins extends Context.Service<DiscordAdmins, DiscordAdminsContract>()(
  'friday/config/DiscordAdmins',
) {}

/**
 * Direct SQLite administration of the Discord admin allow-list. Deliberately
 * does not use the control socket: these commands must work while Friday is
 * not running.
 */
export const DiscordAdminsLive = Layer.effect(
  DiscordAdmins,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // Ensure the database exists with current tables even before first start.
    yield* runMigrations()
    return DiscordAdmins.of({
      // RETURNING yields a row exactly when this statement inserted the user;
      // a conflicting existing row is ignored and reports `exists`.
      add: (userId) =>
        sql<Record<string, unknown>>`
          INSERT INTO admin_discord_users (user_id, created_at)
          VALUES (${userId}, CURRENT_TIMESTAMP)
          ON CONFLICT (user_id) DO NOTHING
          RETURNING user_id
        `.pipe(
          Effect.map((rows): DiscordAdminAddOutcome =>
            rows[0] === undefined ? 'exists' : 'added',
          ),
          Effect.mapError((cause) => new DiscordAdminError({ operation: 'add', userId, cause })),
        ),
      // RETURNING yields a row exactly when this statement deleted the user.
      remove: (userId) =>
        sql<Record<string, unknown>>`
          DELETE FROM admin_discord_users
          WHERE user_id = ${userId}
          RETURNING user_id
        `.pipe(
          Effect.map((rows): DiscordAdminRemoveOutcome =>
            rows[0] === undefined ? 'missing' : 'removed',
          ),
          Effect.mapError((cause) => new DiscordAdminError({ operation: 'remove', userId, cause })),
        ),
      list: () =>
        sql<Record<string, unknown>>`
          SELECT user_id FROM admin_discord_users ORDER BY user_id
        `.pipe(
          Effect.map((rows) =>
            rows.map((row) => {
              // SAFETY: rows are written exclusively through `add`, whose userId
              // argument is validated by the DiscordUserId schema.
              return row.user_id as string
            }),
          ),
          Effect.mapError((cause) => new DiscordAdminError({ operation: 'list', cause })),
        ),
    })
  }),
)
