/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, anti-slop/no-unsafe-dictionary-type -- Bun executes the SQLite integration boundary; SQL rows are decoded or checked immediately. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import {
  LegacyDiscordConfigMigrationError,
  runMigrations,
  runStructuralMigrations,
} from './Migrations.ts'
import {
  DiscordGuildChannelId,
  DiscordGuildId,
  DiscordGuilds,
  DiscordGuildsLive,
} from '../config/DiscordGuilds.ts'
import { PlatformConnectionId } from '@friday/contracts/conversation'

const isLegacyMigrationError = Schema.is(LegacyDiscordConfigMigrationError)
const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeGuildId = Schema.decodeSync(DiscordGuildId)
const decodeChannelId = Schema.decodeSync(DiscordGuildChannelId)

const database = SqliteClient.layer({ filename: ':memory:' })

/** Recreates the pre-guild schema pieces the migration consumes. */
const seedLegacySchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE platform_connections (
      connection_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE discord_connections (
      connection_id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      bot_token_env TEXT NOT NULL,
      respond_to_global_mentions INTEGER NOT NULL,
      FOREIGN KEY (connection_id) REFERENCES platform_connections(connection_id) ON DELETE CASCADE
    )
  `
  yield* sql`
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      audience TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    )
  `
  yield* sql`
    CREATE TABLE platform_access_policies (
      connection_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      PRIMARY KEY (connection_id, subject_type)
    )
  `
  yield* sql`
    CREATE TABLE platform_access_subjects (
      connection_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      platform_subject_id TEXT NOT NULL,
      PRIMARY KEY (connection_id, subject_type, platform_subject_id)
    )
  `
  yield* sql`
    CREATE TABLE platform_invocation_defaults (
      connection_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE platform_channel_invocation_policies (
      connection_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      PRIMARY KEY (connection_id, channel_id)
    )
  `
  yield* sql`
    CREATE TABLE platform_system_channels (
      connection_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, channel_id)
    )
  `
  yield* sql`
    INSERT INTO platform_connections (connection_id, platform, name, enabled, created_at, updated_at)
    VALUES ('discord', 'discord', 'Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `
  yield* sql`
    INSERT INTO discord_connections (connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions)
    VALUES ('discord', 'application-1', 'public-key-1', 'DISCORD_BOT_TOKEN', 1)
  `
  // Guild allow policy: only these two guilds were accessible.
  yield* sql`
    INSERT INTO platform_access_policies (connection_id, subject_type, mode)
    VALUES ('discord', 'guild', 'allow')
  `
  yield* sql`
    INSERT INTO platform_access_subjects (connection_id, subject_type, platform_subject_id)
    VALUES
      ('discord', 'guild', '111111111111111111'),
      ('discord', 'guild', '333333333333333333')
  `
  // Connection-wide invocation default and one channel override, plus a former
  // system-management channel.
  yield* sql`
    INSERT INTO platform_invocation_defaults (connection_id, mode)
    VALUES ('discord', 'all-messages')
  `
  yield* sql`
    INSERT INTO platform_channel_invocation_policies (connection_id, channel_id, mode)
    VALUES ('discord', '999999999999999901', 'mention-only')
  `
  yield* sql`
    INSERT INTO platform_system_channels (connection_id, channel_id, created_at, updated_at)
    VALUES ('discord', '999999999999999902', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `
  // Bindings observe two guilds: 111 (allowed) via two channels, and 222
  // (never allow-listed) via one channel.
  yield* sql`
    INSERT INTO threads (thread_id, audience, status, payload_json, created_at, updated_at)
    VALUES
      (
        'thread-1', 'user', 'active',
        '{"conversationBinding":{"platform":"discord","connectionId":"discord","channelId":"999999999999999901","conversationId":"discord:111111111111111111:999999999999999901"}}',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'thread-2', 'user', 'active',
        '{"conversationBinding":{"platform":"discord","connectionId":"discord","channelId":"999999999999999902","conversationId":"discord:111111111111111111:999999999999999902"}}',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ),
      (
        'thread-3', 'user', 'active',
        '{"conversationBinding":{"platform":"discord","connectionId":"discord","channelId":"999999999999999903","conversationId":"discord:222222222222222222:999999999999999903"}}',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
  `
})

const legacyTableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'platform_invocation_defaults',
        'platform_channel_invocation_policies',
        'platform_system_channels'
      )
    ORDER BY name
  `
  return rows.map((row) => row.name)
})

test('migrates legacy cleanup state, reconciles duplicates, and reruns idempotently', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE threads (
          thread_id TEXT PRIMARY KEY,
          audience TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          closed_at TEXT
        )
      `
      yield* sql`
        INSERT INTO threads (thread_id, audience, status, payload_json, created_at, updated_at)
        VALUES ('cleanup-thread', 'user', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
      yield* sql`
        CREATE TABLE workspace_cleanup_proposals (
          proposal_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'stale')),
          lifecycle_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (lifecycle_status IN ('pending', 'applied', 'stale', 'failed')),
          workspace_path TEXT NOT NULL,
          estimated_bytes INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          applied_at TEXT,
          summary TEXT NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
        )
      `
      yield* sql`
        INSERT INTO workspace_cleanup_proposals (
          proposal_id, thread_id, status, lifecycle_status, workspace_path,
          estimated_bytes, created_at, applied_at, summary
        ) VALUES
          ('cleanup-old', 'cleanup-thread', 'pending', 'pending', '/tmp/workspace', 1,
            '2026-01-01T00:00:00Z', NULL, 'old'),
          ('cleanup-new-z', 'cleanup-thread', 'pending', 'failed', '/tmp/workspace', 1,
            '2026-01-02T00:00:00Z', NULL, 'new z'),
          ('cleanup-new-a', 'cleanup-thread', 'pending', 'pending', '/tmp/workspace', 1,
            '2026-01-02T00:00:00Z', NULL, 'new a')
      `
      yield* sql`
        CREATE TABLE workspace_cleanup_resources (
          proposal_id TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          branch TEXT NOT NULL,
          head TEXT NOT NULL,
          common_directory TEXT NOT NULL,
          status_porcelain TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          removal_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (removal_status IN ('pending', 'removed')),
          PRIMARY KEY (proposal_id, worktree_path),
          FOREIGN KEY (proposal_id) REFERENCES workspace_cleanup_proposals(proposal_id)
            ON DELETE CASCADE
        )
      `
      yield* sql`
        INSERT INTO workspace_cleanup_resources (
          proposal_id, worktree_path, branch, head, common_directory,
          status_porcelain, size_bytes, removal_status
        ) VALUES ('cleanup-new-z', '/tmp/workspace/repo', 'friday/task/repo', 'abc',
          '/tmp/repo.git', '', 1, 'pending')
      `

      yield* runStructuralMigrations()
      yield* sql`
        UPDATE workspace_cleanup_resources
        SET removal_status = 'removing'
        WHERE proposal_id = 'cleanup-new-z'
      `
      const proposals = yield* sql<Record<string, unknown>>`
        SELECT proposal_id, lifecycle_status FROM workspace_cleanup_proposals ORDER BY proposal_id
      `
      assert.deepStrictEqual(proposals, [
        { proposal_id: 'cleanup-new-a', lifecycle_status: 'stale' },
        { proposal_id: 'cleanup-new-z', lifecycle_status: 'failed' },
        { proposal_id: 'cleanup-old', lifecycle_status: 'stale' },
      ])
      const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND name = 'workspace_cleanup_one_active_per_thread'
      `
      assert.strictEqual(indexes.length, 1)
      assert.match(indexes[0]!.sql, /WHERE lifecycle_status IN \('pending', 'failed'\)/)

      yield* runStructuralMigrations()
      const rerun = yield* sql<Record<string, unknown>>`
        SELECT proposal_id, lifecycle_status FROM workspace_cleanup_proposals ORDER BY proposal_id
      `
      assert.deepStrictEqual(rerun, proposals)
      const removing = yield* sql<{ readonly removal_status: string }>`
        SELECT removal_status FROM workspace_cleanup_resources
      `
      assert.strictEqual(removing[0]!.removal_status, 'removing')
    }).pipe(Effect.provide(database)),
  ))

test('migrates connection-scoped Discord configuration into guild-scoped tables', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedLegacySchema
      yield* runMigrations()

      const sql = yield* SqlClient.SqlClient
      const guilds = yield* sql<Record<string, unknown>>`
        SELECT guild_id, enabled, invocation_mode, users_mode
        FROM discord_guilds ORDER BY guild_id
      `
      assert.deepStrictEqual(guilds, [
        // Allow-listed subject: enabled, inheriting the connection invocation default.
        {
          guild_id: '111111111111111111',
          enabled: 1,
          invocation_mode: 'all-messages',
          users_mode: null,
        },
        // Discovered only from bindings and never allow-listed: migrated disabled.
        {
          guild_id: '222222222222222222',
          enabled: 0,
          invocation_mode: 'all-messages',
          users_mode: null,
        },
        // Explicit guild subject without bindings: enabled.
        {
          guild_id: '333333333333333333',
          enabled: 1,
          invocation_mode: 'all-messages',
          users_mode: null,
        },
      ])

      const channels = yield* sql<Record<string, unknown>>`
        SELECT guild_id, channel_id, invocation_mode, users_mode, reply_mode
        FROM discord_guild_channels ORDER BY channel_id
      `
      assert.deepStrictEqual(channels, [
        // Channel invocation override migrates under its observed guild.
        {
          guild_id: '111111111111111111',
          channel_id: '999999999999999901',
          invocation_mode: 'mention-only',
          users_mode: null,
          reply_mode: null,
        },
        // Former system channel becomes a reply-in-channel override.
        {
          guild_id: '111111111111111111',
          channel_id: '999999999999999902',
          invocation_mode: null,
          users_mode: null,
          reply_mode: 'reply-in-channel',
        },
      ])

      // Legacy tables are gone; the subject rows they superseded are cleaned up.
      assert.deepStrictEqual(yield* legacyTableNames, [])
      const leftoverSubjects = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM platform_access_subjects WHERE subject_type = 'guild'
      `
      assert.strictEqual(leftoverSubjects[0]?.count, 0)
    }).pipe(Effect.provide(database)),
  ))

test('refuses and keeps legacy tables when a channel policy has no observable guild', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedLegacySchema
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO platform_channel_invocation_policies (connection_id, channel_id, mode)
        VALUES ('discord', '999999999999999899', 'all-messages')
      `
      const outcome = yield* Effect.exit(runMigrations())
      assert(Exit.isFailure(outcome))
      const error = Exit.findErrorOption(outcome)
      assert(Option.isSome(error))
      assert(isLegacyMigrationError(error.value))
      assert.match(error.value.message, /999999999999999899/)
      assert.match(error.value.message, /no observable guild/)

      // Nothing migrated and no legacy source row was destroyed: the operator
      // can still see and resolve the original policy.
      const migrated = yield* sql<Record<string, unknown>>`
        SELECT * FROM discord_guild_channels
      `
      assert.deepStrictEqual(migrated, [])
      const legacyPolicies = yield* sql<Record<string, unknown>>`
        SELECT channel_id, mode FROM platform_channel_invocation_policies ORDER BY channel_id
      `
      assert.deepStrictEqual(legacyPolicies, [
        { channel_id: '999999999999999899', mode: 'all-messages' },
        { channel_id: '999999999999999901', mode: 'mention-only' },
      ])
    }).pipe(Effect.provide(database)),
  ))

test('refuses when one channel is bound under more than one guild', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedLegacySchema
      const sql = yield* SqlClient.SqlClient
      // The same channel id observed from a second guild makes ownership
      // ambiguous; the migration must not guess between them.
      yield* sql`
        INSERT INTO threads (thread_id, audience, status, payload_json, created_at, updated_at)
        VALUES (
          'thread-4', 'user', 'active',
          '{"conversationBinding":{"platform":"discord","connectionId":"discord","channelId":"999999999999999901","conversationId":"discord:222222222222222222:999999999999999901"}}',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `
      const outcome = yield* Effect.exit(runMigrations())
      assert(Exit.isFailure(outcome))
      const error = Exit.findErrorOption(outcome)
      assert(Option.isSome(error))
      assert(isLegacyMigrationError(error.value))
      assert.match(error.value.message, /bound under 2 guilds/)
      const migrated = yield* sql<Record<string, unknown>>`
        SELECT * FROM discord_guild_channels
      `
      assert.deepStrictEqual(migrated, [])
    }).pipe(Effect.provide(database)),
  ))

test('a recorded guild channel override resolves an unobservable-guild refusal', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedLegacySchema
      const sql = yield* SqlClient.SqlClient
      // A legacy policy whose guild cannot be observed refuses startup.
      yield* sql`
        INSERT INTO platform_channel_invocation_policies (connection_id, channel_id, mode)
        VALUES ('discord', '999999999999999899', 'all-messages')
      `
      const refused = yield* Effect.exit(runMigrations())
      const error = Exit.findErrorOption(refused)
      assert(Exit.isFailure(refused) && Option.isSome(error))
      assert(isLegacyMigrationError(error.value))

      // The documented recovery: the config CLI's guild commands still work
      // while the refusal is in place, so the operator records the equivalent
      // guild configuration through the same live service layer the CLI
      // builds.
      yield* Effect.gen(function* () {
        const store = yield* DiscordGuilds
        const connectionId = decodeConnectionId('discord')
        const guildId = decodeGuildId('111111111111111111')
        assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'enabled')
        assert.strictEqual(
          yield* store.setChannel(connectionId, guildId, decodeChannelId('999999999999999899'), {
            invocationMode: 'all-messages',
          }),
          'updated',
        )

        // The migration re-run recognizes the recorded override as the
        // resolution: it succeeds, keeps the recording exactly as recorded, and
        // clears the legacy tables.
        yield* runMigrations()
        const recorded = yield* sql<Record<string, unknown>>`
          SELECT guild_id, invocation_mode, users_mode, reply_mode
          FROM discord_guild_channels
          WHERE channel_id = '999999999999999899'
        `
        assert.deepStrictEqual(recorded, [
          {
            guild_id: '111111111111111111',
            invocation_mode: 'all-messages',
            users_mode: null,
            reply_mode: null,
          },
        ])
        assert.deepStrictEqual(yield* legacyTableNames, [])
      }).pipe(Effect.provide(DiscordGuildsLive))
    }).pipe(Effect.provide(database)),
  ))

test('a recorded guild channel override resolves an ambiguous-guild refusal and supersedes the legacy mode', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedLegacySchema
      const sql = yield* SqlClient.SqlClient
      // Channel 901 carries a mention-only invocation policy and is bound
      // under a second guild, making its placement ambiguous.
      yield* sql`
        INSERT INTO threads (thread_id, audience, status, payload_json, created_at, updated_at)
        VALUES (
          'thread-4', 'user', 'active',
          '{"conversationBinding":{"platform":"discord","connectionId":"discord","channelId":"999999999999999901","conversationId":"discord:222222222222222222:999999999999999901"}}',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `
      const refused = yield* Effect.exit(runMigrations())
      assert(Exit.isFailure(refused))

      // The operator resolves the ambiguity by explicitly choosing the owning
      // guild through the config CLI, deliberately recording a different
      // invocation mode than the legacy row carried.
      yield* Effect.gen(function* () {
        const store = yield* DiscordGuilds
        const connectionId = decodeConnectionId('discord')
        const guildId = decodeGuildId('111111111111111111')
        assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'enabled')
        assert.strictEqual(
          yield* store.setChannel(connectionId, guildId, decodeChannelId('999999999999999901'), {
            invocationMode: 'all-messages',
          }),
          'updated',
        )

        yield* runMigrations()
        // The recorded override stands exactly as recorded; the ambiguous
        // legacy row is not migrated on top of it and not duplicated elsewhere.
        const overrides = yield* sql<Record<string, unknown>>`
          SELECT guild_id, invocation_mode, reply_mode
          FROM discord_guild_channels
          WHERE channel_id = '999999999999999901'
          ORDER BY guild_id
        `
        assert.deepStrictEqual(overrides, [
          {
            guild_id: '111111111111111111',
            invocation_mode: 'all-messages',
            reply_mode: null,
          },
        ])
        assert.deepStrictEqual(yield* legacyTableNames, [])
      }).pipe(Effect.provide(DiscordGuildsLive))
    }).pipe(Effect.provide(database)),
  ))

test('recovery rows supersede only matching fields and preserve unrelated legacy behavior', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedLegacySchema
      const sql = yield* SqlClient.SqlClient
      const channels = ['999999999999999904', '999999999999999905', '999999999999999906'] as const
      yield* sql`
        INSERT INTO platform_channel_invocation_policies (connection_id, channel_id, mode)
        VALUES
          ('discord', ${channels[0]}, 'mention-only'),
          ('discord', ${channels[1]}, 'mention-only'),
          ('discord', ${channels[2]}, 'mention-only')
      `
      yield* sql`
        INSERT INTO platform_system_channels (connection_id, channel_id, created_at, updated_at)
        VALUES
          ('discord', ${channels[0]}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('discord', ${channels[1]}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ('discord', ${channels[2]}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `

      // None of the three channels has an observable guild yet, so migration
      // creates the current schema and then rolls back its data changes.
      const refused = yield* Effect.exit(runMigrations())
      assert(Exit.isFailure(refused))

      yield* Effect.gen(function* () {
        const store = yield* DiscordGuilds
        const connectionId = decodeConnectionId('discord')
        const guildId = decodeGuildId('111111111111111111')
        assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'enabled')

        // Invocation-only: explicit invocation wins; legacy system behavior
        // must still become reply-in-channel.
        assert.strictEqual(
          yield* store.setChannel(connectionId, guildId, decodeChannelId(channels[0]), {
            invocationMode: 'all-messages',
          }),
          'updated',
        )
        // Reply-only: explicit reply wins; legacy invocation must survive.
        assert.strictEqual(
          yield* store.setChannel(connectionId, guildId, decodeChannelId(channels[1]), {
            replyMode: 'reply-in-thread',
          }),
          'updated',
        )
        // Users-only: the row names ownership but supersedes neither legacy
        // behavior.
        assert.strictEqual(
          yield* store.setChannel(connectionId, guildId, decodeChannelId(channels[2]), {
            users: { mode: 'allow', ids: ['444444444444444444'] },
          }),
          'updated',
        )

        yield* runMigrations()

        const recovered = (yield* store.listGuilds(connectionId))[0]
        assert(recovered)
        assert.deepStrictEqual(
          recovered.channels.filter((channel) =>
            channels.some((channelId) => channelId === channel.channelId),
          ),
          [
            {
              channelId: channels[0],
              invocationMode: 'all-messages',
              replyMode: 'reply-in-channel',
            },
            {
              channelId: channels[1],
              invocationMode: 'mention-only',
              replyMode: 'reply-in-thread',
            },
            {
              channelId: channels[2],
              invocationMode: 'mention-only',
              users: { mode: 'allow', ids: ['444444444444444444'] },
              replyMode: 'reply-in-channel',
            },
          ],
        )
        assert.deepStrictEqual(yield* legacyTableNames, [])
      }).pipe(Effect.provide(DiscordGuildsLive))
    }).pipe(Effect.provide(database)),
  ))

test('refuses when legacy channel access policies exist', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedLegacySchema
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO platform_access_policies (connection_id, subject_type, mode)
        VALUES ('discord', 'channel', 'allow')
      `
      const outcome = yield* Effect.exit(runMigrations())
      assert(Exit.isFailure(outcome))
      const error = Exit.findErrorOption(outcome)
      assert(Option.isSome(error))
      assert(isLegacyMigrationError(error.value))
      assert.match(error.value.message, /channel access policies/)
      // The legacy tables survive so the operator can review the policy.
      assert.deepStrictEqual(yield* legacyTableNames, [
        'platform_channel_invocation_policies',
        'platform_invocation_defaults',
        'platform_system_channels',
      ])
    }).pipe(Effect.provide(database)),
  ))

test('merges a channel that is both an invocation override and a system channel', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seedLegacySchema
      const sql = yield* SqlClient.SqlClient
      // Channel 901 already carries a mention-only invocation policy; a second
      // legacy feature (system channels) records the same channel id. The
      // migration must merge both semantics into one override row.
      yield* sql`
        INSERT INTO platform_system_channels (connection_id, channel_id, created_at, updated_at)
        VALUES ('discord', '999999999999999901', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
      yield* runMigrations()

      const merged = yield* sql<Record<string, unknown>>`
        SELECT guild_id, channel_id, invocation_mode, users_mode, reply_mode
        FROM discord_guild_channels
        WHERE channel_id = '999999999999999901'
      `
      assert.deepStrictEqual(merged, [
        {
          guild_id: '111111111111111111',
          channel_id: '999999999999999901',
          invocation_mode: 'mention-only',
          users_mode: null,
          reply_mode: 'reply-in-channel',
        },
      ])
    }).pipe(Effect.provide(database)),
  ))

test('refuses a partial legacy schema instead of skipping or guessing', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE platform_channel_invocation_policies (
          connection_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          PRIMARY KEY (connection_id, channel_id)
        )
      `

      const outcome = yield* Effect.exit(runMigrations())
      assert(Exit.isFailure(outcome))
      const error = Exit.findErrorOption(outcome)
      assert(Option.isSome(error))
      assert(isLegacyMigrationError(error.value))
      assert.match(error.value.message, /partial legacy schema/)
      assert.match(error.value.message, /platform_channel_invocation_policies/)
      assert.match(error.value.message, /platform_invocation_defaults/)
      assert.match(error.value.message, /platform_system_channels/)
      assert.deepStrictEqual(yield* legacyTableNames, ['platform_channel_invocation_policies'])
    }).pipe(Effect.provide(database)),
  ))

test('skips the migration when the legacy tables are absent', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      // Fresh database: runMigrations creates the current schema directly.
      yield* runMigrations()
      assert.deepStrictEqual(yield* legacyTableNames, [])
      const sql = yield* SqlClient.SqlClient
      const guilds = yield* sql<Record<string, unknown>>`SELECT * FROM discord_guilds`
      assert.deepStrictEqual(guilds, [])
      // Re-running stays a no-op.
      yield* runMigrations()
      assert.deepStrictEqual(yield* legacyTableNames, [])
    }).pipe(Effect.provide(database)),
  ))

test('canonicalizes Discord channel bindings and closes newer active duplicates', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations()
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        INSERT INTO threads (
          thread_id, audience, status, payload_json, created_at, updated_at, closed_at
        ) VALUES
          (
            'channel-old', 'user', 'active',
            '{"id":"channel-old","status":"active","conversationBinding":{"platform":"discord","connectionId":"discord","channelId":"discord:111111111111111111:999999999999999901","conversationId":"discord:111111111111111111:999999999999999901"}}',
            '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
          ),
          (
            'channel-new', 'user', 'active',
            '{"id":"channel-new","status":"active","conversationBinding":{"platform":"discord","connectionId":"discord","channelId":"discord:111111111111111111:999999999999999901","conversationId":"discord:111111111111111111:999999999999999901:999999999999999901"}}',
            '2026-09-01T01:00:00.000Z', '2026-09-01T01:00:00.000Z', NULL
          ),
          (
            'channel-only', 'user', 'active',
            '{"id":"channel-only","status":"active","conversationBinding":{"platform":"discord","connectionId":"discord","channelId":"discord:111111111111111111:999999999999999902","conversationId":"discord:111111111111111111:999999999999999902"}}',
            '2026-09-01T02:00:00.000Z', '2026-09-01T02:00:00.000Z', NULL
          )
      `

      yield* runMigrations()

      const rows = yield* sql<{
        readonly thread_id: string
        readonly status: string
        readonly conversation_id: string
      }>`
        SELECT
          thread_id,
          status,
          json_extract(payload_json, '$.conversationBinding.conversationId') AS conversation_id
        FROM threads
        ORDER BY thread_id
      `
      assert.deepStrictEqual(rows, [
        {
          thread_id: 'channel-new',
          status: 'closed',
          conversation_id: 'discord:111111111111111111:999999999999999901:999999999999999901',
        },
        {
          thread_id: 'channel-old',
          status: 'active',
          conversation_id: 'discord:111111111111111111:999999999999999901:999999999999999901',
        },
        {
          thread_id: 'channel-only',
          status: 'active',
          conversation_id: 'discord:111111111111111111:999999999999999902:999999999999999902',
        },
      ])
    }).pipe(Effect.provide(database)),
  ))

test('adds the guild channel scope column to pre-scope databases', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Pre-create the guild tables in their pre-scope shape; structural
      // migrations must keep them and add the missing column idempotently.
      yield* sql`
        CREATE TABLE platform_connections (
          connection_id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `
      yield* sql`
        CREATE TABLE discord_connections (
          connection_id TEXT PRIMARY KEY,
          application_id TEXT NOT NULL,
          public_key TEXT NOT NULL,
          bot_token_env TEXT NOT NULL,
          respond_to_global_mentions INTEGER NOT NULL,
          FOREIGN KEY (connection_id) REFERENCES platform_connections(connection_id) ON DELETE CASCADE
        )
      `
      yield* sql`
        CREATE TABLE discord_guilds (
          connection_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          invocation_mode TEXT NOT NULL CHECK (invocation_mode IN ('mention-only', 'all-messages')),
          users_mode TEXT CHECK (users_mode IN ('all', 'allow', 'deny')),
          PRIMARY KEY (connection_id, guild_id),
          FOREIGN KEY (connection_id) REFERENCES discord_connections(connection_id) ON DELETE CASCADE
        )
      `
      yield* sql`
        INSERT INTO discord_guilds (connection_id, guild_id, enabled, invocation_mode, users_mode)
        VALUES ('discord', '111111111111111111', 1, 'mention-only', NULL)
      `

      yield* runStructuralMigrations()
      yield* runStructuralMigrations()

      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('discord_guilds') ORDER BY name
      `
      assert.deepStrictEqual(
        columns.map((column) => column.name),
        ['channels_mode', 'connection_id', 'enabled', 'guild_id', 'invocation_mode', 'users_mode'],
      )
      // The pre-existing row survives with a NULL scope (every channel admitted).
      const rows = yield* sql<{ readonly channels_mode: string | null }>`
        SELECT channels_mode FROM discord_guilds
      `
      assert.strictEqual(rows[0]?.channels_mode, null)
    }).pipe(Effect.provide(database)),
  ))
