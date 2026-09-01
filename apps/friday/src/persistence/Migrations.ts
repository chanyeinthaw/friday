import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runChatSdkStateMigrations } from '../platforms/chat-sdk/SqliteChatStateAdapter.ts'

/**
 * The legacy Discord configuration could not be mapped exactly, so the
 * migration rolled back instead of guessing. Friday refuses to start until an
 * operator resolves the listed rows; the legacy tables are left untouched so
 * no policy is silently dropped or widened.
 */
export class LegacyDiscordConfigMigrationError extends Schema.Error<LegacyDiscordConfigMigrationError>(
  'LegacyDiscordConfigMigrationError',
)({
  _tag: Schema.tag('LegacyDiscordConfigMigrationError'),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Legacy Discord configuration migration refused: ${this.detail}. The migration rolled back and the legacy tables are unchanged. The guild configuration CLI commands still work while this refusal is in place: record the equivalent guild configuration for the listed channels (each explicitly recorded field supersedes only its matching legacy behavior; unrelated legacy fields still migrate), resolve any listed rows that have no guild-model equivalent directly in the legacy tables, then restart Friday.`
  }
}

/**
 * Structural schema creation and idempotent data repair, without the
 * fail-closed legacy Discord migration. Runs to completion even while a
 * legacy-migration refusal keeps the legacy tables in place.
 */
export const runStructuralMigrations = Effect.fn('runStructuralMigrations')(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`PRAGMA foreign_keys = ON`
  yield* runChatSdkStateMigrations()

  yield* sql`
    CREATE TABLE IF NOT EXISTS installation_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      installation_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `

  yield* sql`
    INSERT OR IGNORE INTO installation_config (id, installation_id, created_at)
    VALUES (1, lower(hex(randomblob(16))), CURRENT_TIMESTAMP)
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS admin_discord_users (
      user_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      primary_provider TEXT NOT NULL,
      primary_model_id TEXT NOT NULL,
      primary_thinking_level TEXT NOT NULL,
      utility_provider TEXT NOT NULL,
      utility_model_id TEXT NOT NULL,
      utility_thinking_level TEXT NOT NULL,
      recent_message_count INTEGER NOT NULL CHECK (recent_message_count BETWEEN 0 AND 100),
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    INSERT OR IGNORE INTO agent_config (
      id,
      primary_provider,
      primary_model_id,
      primary_thinking_level,
      utility_provider,
      utility_model_id,
      utility_thinking_level,
      recent_message_count,
      updated_at
    ) VALUES (
      1,
      'openai-multi',
      'gpt-5.6-terra',
      'medium',
      'opencode-go',
      'glm-5.3-flash',
      'low',
      20,
      CURRENT_TIMESTAMP
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS subagent_profiles (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      thinking_level TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    INSERT OR IGNORE INTO subagent_profiles (
      name, description, provider, model_id, thinking_level, updated_at
    ) VALUES (
      'primary',
      'Default profile for general delegated work.',
      'opencode-go',
      'glm-5.3-flash',
      'max',
      CURRENT_TIMESTAMP
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS platform_connections (
      connection_id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS discord_connections (
      connection_id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      public_key TEXT NOT NULL,
      bot_token_env TEXT NOT NULL,
      respond_to_global_mentions INTEGER NOT NULL CHECK (respond_to_global_mentions IN (0, 1)),
      activity_description_public INTEGER NOT NULL DEFAULT 0
        CHECK (activity_description_public IN (0, 1)),
      FOREIGN KEY (connection_id) REFERENCES platform_connections(connection_id) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS discord_connections_application_id
    ON discord_connections (application_id)
  `

  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('discord_connections')
  `
  if (!columns.some((column) => column.name === 'activity_description_public')) {
    yield* sql`
      ALTER TABLE discord_connections
      ADD COLUMN activity_description_public INTEGER NOT NULL DEFAULT 0
        CHECK (activity_description_public IN (0, 1))
    `
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS discord_guilds (
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
    CREATE TABLE IF NOT EXISTS discord_guild_users (
      connection_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (connection_id, guild_id, user_id),
      FOREIGN KEY (connection_id, guild_id)
        REFERENCES discord_guilds(connection_id, guild_id) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS discord_guild_channels (
      connection_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      invocation_mode TEXT CHECK (invocation_mode IN ('mention-only', 'all-messages')),
      users_mode TEXT CHECK (users_mode IN ('all', 'allow', 'deny')),
      reply_mode TEXT CHECK (reply_mode IN ('reply-in-thread', 'reply-in-channel')),
      PRIMARY KEY (connection_id, guild_id, channel_id),
      FOREIGN KEY (connection_id, guild_id)
        REFERENCES discord_guilds(connection_id, guild_id) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS discord_guild_channel_users (
      connection_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (connection_id, guild_id, channel_id, user_id),
      FOREIGN KEY (connection_id, guild_id, channel_id)
        REFERENCES discord_guild_channels(connection_id, guild_id, channel_id) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS discord_mention_roles (
      connection_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (connection_id, role_id),
      FOREIGN KEY (connection_id) REFERENCES discord_connections(connection_id) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS platform_access_policies (
      connection_id TEXT NOT NULL,
      subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'workspace')),
      mode TEXT NOT NULL CHECK (mode IN ('all', 'allow', 'deny')),
      PRIMARY KEY (connection_id, subject_type),
      FOREIGN KEY (connection_id) REFERENCES platform_connections(connection_id) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS platform_access_subjects (
      connection_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      platform_subject_id TEXT NOT NULL,
      PRIMARY KEY (connection_id, subject_type, platform_subject_id),
      FOREIGN KEY (connection_id, subject_type)
        REFERENCES platform_access_policies(connection_id, subject_type) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_cleanup_proposals (
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

  const cleanupProposalColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('workspace_cleanup_proposals')
  `
  if (!cleanupProposalColumns.some((column) => column.name === 'lifecycle_status')) {
    yield* sql`
      ALTER TABLE workspace_cleanup_proposals
      ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (lifecycle_status IN ('pending', 'applied', 'stale', 'failed'))
    `
    yield* sql`
      UPDATE workspace_cleanup_proposals
      SET lifecycle_status = status
    `
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_cleanup_resources (
      proposal_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      head TEXT NOT NULL,
      common_directory TEXT NOT NULL,
      status_porcelain TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      removal_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (removal_status IN ('pending', 'removing', 'removed')),
      PRIMARY KEY (proposal_id, worktree_path),
      FOREIGN KEY (proposal_id) REFERENCES workspace_cleanup_proposals(proposal_id) ON DELETE CASCADE
    )
  `

  const cleanupResourceColumns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('workspace_cleanup_resources')
  `
  if (!cleanupResourceColumns.some((column) => column.name === 'removal_status')) {
    yield* sql`
      ALTER TABLE workspace_cleanup_resources
      ADD COLUMN removal_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (removal_status IN ('pending', 'removing', 'removed'))
    `
  }

  const cleanupResourceTable = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'workspace_cleanup_resources'
  `
  if (!cleanupResourceTable[0]?.sql.includes("'removing'")) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          CREATE TABLE workspace_cleanup_resources_next (
            proposal_id TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            branch TEXT NOT NULL,
            head TEXT NOT NULL,
            common_directory TEXT NOT NULL,
            status_porcelain TEXT NOT NULL,
            size_bytes INTEGER NOT NULL,
            removal_status TEXT NOT NULL DEFAULT 'pending'
              CHECK (removal_status IN ('pending', 'removing', 'removed')),
            PRIMARY KEY (proposal_id, worktree_path),
            FOREIGN KEY (proposal_id) REFERENCES workspace_cleanup_proposals(proposal_id)
              ON DELETE CASCADE
          )
        `
        yield* sql`
          INSERT INTO workspace_cleanup_resources_next
          SELECT proposal_id, worktree_path, branch, head, common_directory,
            status_porcelain, size_bytes, removal_status
          FROM workspace_cleanup_resources
        `
        yield* sql`DROP TABLE workspace_cleanup_resources`
        yield* sql`
          ALTER TABLE workspace_cleanup_resources_next
          RENAME TO workspace_cleanup_resources
        `
      }),
    )
  }

  // Keep the newest active proposal for each thread. Older duplicates were
  // never the proposal returned by `propose`, so marking them stale preserves
  // the previously visible winner before the uniqueness rule is installed.
  yield* sql`
    UPDATE workspace_cleanup_proposals
    SET status = 'stale', lifecycle_status = 'stale'
    WHERE lifecycle_status IN ('pending', 'failed')
      AND proposal_id NOT IN (
        SELECT winner.proposal_id
        FROM workspace_cleanup_proposals AS winner
        WHERE winner.lifecycle_status IN ('pending', 'failed')
          AND winner.proposal_id = (
            SELECT candidate.proposal_id
            FROM workspace_cleanup_proposals AS candidate
            WHERE candidate.thread_id = winner.thread_id
              AND candidate.lifecycle_status IN ('pending', 'failed')
            ORDER BY candidate.created_at DESC, candidate.proposal_id DESC
            LIMIT 1
          )
      )
  `

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_cleanup_one_active_per_thread
    ON workspace_cleanup_proposals (thread_id)
    WHERE lifecycle_status IN ('pending', 'failed')
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS threads (
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
    UPDATE threads
    SET payload_json = json_set(
      payload_json,
      '$.conversationBinding.connectionId',
      json_extract(payload_json, '$.conversationBinding.platform')
    )
    WHERE audience = 'user'
      AND json_extract(payload_json, '$.conversationBinding.connectionId') IS NULL
  `

  yield* sql`
    UPDATE threads
    SET payload_json = json_set(
      payload_json,
      '$.channelContext',
      json_object(
        'name', json_extract(payload_json, '$.conversationBinding.channelId'),
        'description', ''
      )
    )
    WHERE audience = 'user'
      AND json_extract(payload_json, '$.channelContext') IS NULL
  `

  yield* sql`
    UPDATE threads
    SET payload_json = json_set(payload_json, '$.role', 'subagent')
    WHERE audience = 'agent'
      AND json_extract(payload_json, '$.role') IS NULL
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS turns (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS turns_thread_sequence
    ON turns (thread_id, sequence)
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS activities (
      activity_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (turn_id) REFERENCES turns(turn_id)
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS activities_turn_sequence
    ON activities (turn_id, sequence)
  `

  // Discord channel conversations use the channel id as their fourth segment.
  // Close newer active duplicates before canonicalizing older three-part bindings.
  yield* sql`
    UPDATE threads AS duplicate
    SET
      status = 'closed',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      payload_json = json_set(
        duplicate.payload_json,
        '$.status',
        'closed',
        '$.updatedAt',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        '$.closedAt',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
    WHERE duplicate.audience = 'user'
      AND duplicate.status = 'active'
      AND json_extract(duplicate.payload_json, '$.conversationBinding.platform') = 'discord'
      AND EXISTS (
        SELECT 1
        FROM threads AS survivor
        WHERE survivor.thread_id != duplicate.thread_id
          AND survivor.audience = 'user'
          AND survivor.status = 'active'
          AND json_extract(survivor.payload_json, '$.conversationBinding.platform') = 'discord'
          AND json_extract(survivor.payload_json, '$.conversationBinding.connectionId') =
            json_extract(duplicate.payload_json, '$.conversationBinding.connectionId')
          AND CASE
            WHEN length(json_extract(survivor.payload_json, '$.conversationBinding.conversationId')) -
              length(replace(json_extract(survivor.payload_json, '$.conversationBinding.conversationId'), ':', '')) = 2
            THEN json_extract(survivor.payload_json, '$.conversationBinding.conversationId') || ':' ||
              substr(
                json_extract(survivor.payload_json, '$.conversationBinding.conversationId'),
                instr(substr(json_extract(survivor.payload_json, '$.conversationBinding.conversationId'), 9), ':') + 9
              )
            ELSE json_extract(survivor.payload_json, '$.conversationBinding.conversationId')
          END = CASE
            WHEN length(json_extract(duplicate.payload_json, '$.conversationBinding.conversationId')) -
              length(replace(json_extract(duplicate.payload_json, '$.conversationBinding.conversationId'), ':', '')) = 2
            THEN json_extract(duplicate.payload_json, '$.conversationBinding.conversationId') || ':' ||
              substr(
                json_extract(duplicate.payload_json, '$.conversationBinding.conversationId'),
                instr(substr(json_extract(duplicate.payload_json, '$.conversationBinding.conversationId'), 9), ':') + 9
              )
            ELSE json_extract(duplicate.payload_json, '$.conversationBinding.conversationId')
          END
          AND (survivor.created_at < duplicate.created_at OR (
            survivor.created_at = duplicate.created_at AND survivor.thread_id < duplicate.thread_id
          ))
      )
  `

  yield* sql`
    UPDATE threads
    SET payload_json = json_set(
      payload_json,
      '$.conversationBinding.conversationId',
      json_extract(payload_json, '$.conversationBinding.conversationId') || ':' ||
        substr(
          json_extract(payload_json, '$.conversationBinding.conversationId'),
          instr(substr(json_extract(payload_json, '$.conversationBinding.conversationId'), 9), ':') + 9
        )
    )
    WHERE audience = 'user'
      AND json_extract(payload_json, '$.conversationBinding.platform') = 'discord'
      AND length(json_extract(payload_json, '$.conversationBinding.conversationId')) -
        length(replace(json_extract(payload_json, '$.conversationBinding.conversationId'), ':', '')) = 2
  `
})

export const runMigrations = Effect.fn('runMigrations')(function* () {
  // Structural migrations run first so every table exists even while a legacy
  // refusal keeps the legacy tables in place; the refusal then fails startup
  // closed until the operator resolves or records the listed rows.
  yield* runStructuralMigrations()
  yield* migrateConnectionScopedDiscordConfig()
})

/** Parses the guild segment of a Discord conversation id (`discord:{guild}:{channel}[:{thread}]`). */
const discordGuildFromConversationId = (column: string) =>
  `substr(substr(${column}, 9), 1, instr(substr(${column}, 9), ':') - 1)`

/** Keeps failure reports readable when many rows share one problem. */
const capList = (items: ReadonlyArray<string>): string =>
  items.length <= 20
    ? items.join(', ')
    : `${items.slice(0, 20).join(', ')} … (+${items.length - 20} more)`

/**
 * One-time migration of the pre-guild Discord configuration. Connection-scoped
 * invocation defaults, channel invocation policies, and system channels are
 * replaced by guild-scoped configuration, so every migrated row needs the guild
 * that owns its channel. The migration is fail-closed: when any legacy policy
 * row cannot be mapped exactly — a channel whose guild cannot be observed, a
 * channel bound under more than one guild, or channel access policies that
 * have no per-channel equivalent in the guild model — it aborts, rolls back,
 * and reports the rows for operator action. Nothing is widened and no legacy
 * row is destroyed; guild IDs are only ever taken from real data (existing
 * guild access subjects and the guild segment of persisted conversation
 * bindings), never guessed.
 *
 * Recovery: the guild configuration CLI commands run even while a refusal is
 * in place (the config layer tolerates this error), so the operator can record
 * the equivalent guild configuration. A recorded channel row names the owning
 * guild. Each non-null field supersedes only its matching legacy behavior;
 * unrelated legacy fields merge into the row and recorded fields are never
 * overwritten. Legacy rows with no guild-model equivalent (channel access
 * policies) have no recording path and must be resolved directly in the legacy
 * tables.
 */
export const migrateConnectionScopedDiscordConfig = Effect.fn(
  'migrateConnectionScopedDiscordConfig',
)(function* () {
  const sql = yield* SqlClient.SqlClient
  const expectedLegacyTables = [
    'platform_invocation_defaults',
    'platform_channel_invocation_policies',
    'platform_system_channels',
  ] as const
  const legacyTables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'platform_invocation_defaults',
        'platform_channel_invocation_policies',
        'platform_system_channels'
      )
      ORDER BY name
    `
  if (legacyTables.length === 0) return
  const presentLegacyTables = new Set(legacyTables.map((row) => row.name))
  const missingLegacyTables = expectedLegacyTables.filter(
    (table) => !presentLegacyTables.has(table),
  )
  if (missingLegacyTables.length > 0) {
    return yield* new LegacyDiscordConfigMigrationError({
      detail: `partial legacy schema: found ${[...presentLegacyTables].join(', ')} but missing ${missingLegacyTables.join(', ')}`,
    })
  }

  const conversationIdExpression =
    "json_extract(t.payload_json, '$.conversationBinding.conversationId')"
  const guildExpression = discordGuildFromConversationId(conversationIdExpression)
  // (connection_id, guild_id, channel_id) locations observed in persisted bindings.
  const bindingLocations = `
    SELECT DISTINCT
      pc.connection_id AS connection_id,
      ${guildExpression} AS guild_id,
      json_extract(t.payload_json, '$.conversationBinding.channelId') AS channel_id
    FROM threads t
    JOIN platform_connections pc
      ON pc.connection_id = json_extract(t.payload_json, '$.conversationBinding.connectionId')
    WHERE pc.platform = 'discord'
      AND ${conversationIdExpression} LIKE 'discord:%'
      AND ${guildExpression} != ''
  `
  // The migration statements embed composed SQL fragments, so they run as raw
  // queries; every fragment is static, with no external parameters.
  const unsafe = <A extends object>(query: string) => sql.unsafe<A>(query)

  yield* sql.withTransaction(
    Effect.gen(function* () {
      // ---- Fail-closed pre-checks: any unmappable legacy row aborts the
      // whole migration (the transaction rolls back) before one byte of the
      // new tables is written.
      const problems: Array<string> = []

      // Snapshot rows recorded before this migration pass. Guild ownership and
      // field supersession are separate facts: a users-only row can locate a
      // legacy behavior but cannot suppress it. The snapshot also prevents the
      // first legacy insert from looking explicitly recorded to the second.
      yield* unsafe(`
        CREATE TEMP TABLE IF NOT EXISTS migration_recorded_channels (
          connection_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          invocation_recorded INTEGER NOT NULL,
          reply_recorded INTEGER NOT NULL,
          PRIMARY KEY (connection_id, guild_id, channel_id)
        )
      `)
      yield* unsafe(`DELETE FROM migration_recorded_channels`)
      yield* unsafe(`
        INSERT INTO migration_recorded_channels
          (connection_id, guild_id, channel_id, invocation_recorded, reply_recorded)
        SELECT
          connection_id,
          guild_id,
          channel_id,
          invocation_mode IS NOT NULL,
          reply_mode IS NOT NULL
        FROM discord_guild_channels
      `)

      // Check ownership for each unsuperseded legacy behavior. A matching
      // recorded field removes only that behavior from consideration. Otherwise
      // one recorded guild is authoritative; without one, exactly one observed
      // binding is required. Multiple recorded guilds or observed guilds remain
      // fail-closed.
      const ownershipProblems = (
        source: string,
        table: string,
        modeExpression: string,
        recordedColumn: 'invocation_recorded' | 'reply_recorded',
      ) =>
        unsafe<{
          readonly connection_id: string
          readonly channel_id: string
          readonly mode: string
          readonly recorded_guild_count: number
          readonly observed_guild_count: number
        }>(`
          SELECT
            legacy.connection_id,
            legacy.channel_id,
            ${modeExpression} AS mode,
            (
              SELECT COUNT(DISTINCT rec.guild_id)
              FROM migration_recorded_channels rec
              WHERE rec.connection_id = legacy.connection_id
                AND rec.channel_id = legacy.channel_id
            ) AS recorded_guild_count,
            (
              SELECT COUNT(DISTINCT b.guild_id)
              FROM (${bindingLocations}) b
              WHERE b.connection_id = legacy.connection_id
                AND b.channel_id = legacy.channel_id
            ) AS observed_guild_count
          FROM ${table} legacy
          WHERE NOT EXISTS (
            SELECT 1
            FROM migration_recorded_channels rec
            WHERE rec.connection_id = legacy.connection_id
              AND rec.channel_id = legacy.channel_id
              AND rec.${recordedColumn} = 1
          )
        `).pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => {
              if (row.recorded_guild_count > 1) {
                return [
                  `channel ${row.channel_id} on connection ${row.connection_id} (${source}, ${row.mode}) is recorded under ${row.recorded_guild_count} guilds`,
                ]
              }
              if (row.recorded_guild_count === 1) return []
              if (row.observed_guild_count === 0) {
                return [
                  `channel ${row.channel_id} on connection ${row.connection_id} (${source}, ${row.mode}) has no observable guild`,
                ]
              }
              if (row.observed_guild_count > 1) {
                return [
                  `channel ${row.channel_id} on connection ${row.connection_id} (${source}, ${row.mode}) is bound under ${row.observed_guild_count} guilds`,
                ]
              }
              return []
            }),
          ),
        )
      problems.push(
        ...(yield* ownershipProblems(
          'channel invocation policy',
          'platform_channel_invocation_policies',
          'legacy.mode',
          'invocation_recorded',
        )),
        ...(yield* ownershipProblems(
          'system channel',
          'platform_system_channels',
          "'reply-in-channel'",
          'reply_recorded',
        )),
      )

      // Channel access policies gate whole channels, which the guild model
      // (enabled guilds with per-channel overrides) cannot express; mapping
      // or dropping them would change who reaches Friday.
      const channelPolicyConnections = yield* unsafe<{ readonly connection_id: string }>(`
        SELECT DISTINCT connection_id FROM platform_access_policies WHERE subject_type = 'channel'
        UNION
        SELECT DISTINCT connection_id FROM platform_access_subjects WHERE subject_type = 'channel'
      `)
      for (const row of channelPolicyConnections) {
        problems.push(
          `connection ${row.connection_id} has channel access policies, which have no per-channel equivalent in the guild model; resolve these legacy rows directly`,
        )
      }

      if (problems.length > 0) {
        return yield* new LegacyDiscordConfigMigrationError({
          detail: capList(problems),
        })
      }

      // Discovered guilds: explicit guild access subjects plus guilds observed
      // in bindings. Enabled flags follow the old guild access policy; invocation
      // defaults carry over from the connection default they effectively were.
      yield* unsafe(`
        INSERT OR IGNORE INTO discord_guilds (connection_id, guild_id, enabled, invocation_mode, users_mode)
        SELECT
          g.connection_id,
          g.guild_id,
          CASE
            WHEN gp.mode IS NULL THEN 1
            WHEN gp.mode = 'all' THEN 1
            WHEN gp.mode = 'allow' THEN gs.platform_subject_id IS NOT NULL
            ELSE gs.platform_subject_id IS NULL
          END,
          COALESCE(idf.mode, 'mention-only'),
          NULL
        FROM (
          SELECT pc.connection_id AS connection_id, ${guildExpression} AS guild_id
          FROM threads t
          JOIN platform_connections pc
            ON pc.connection_id = json_extract(t.payload_json, '$.conversationBinding.connectionId')
          WHERE pc.platform = 'discord'
            AND ${conversationIdExpression} LIKE 'discord:%'
            AND ${guildExpression} != ''
          UNION
          SELECT s.connection_id, s.platform_subject_id
          FROM platform_access_subjects s
          JOIN platform_connections pc ON pc.connection_id = s.connection_id
          WHERE s.subject_type = 'guild' AND pc.platform = 'discord'
        ) g
        LEFT JOIN platform_access_policies gp
          ON gp.connection_id = g.connection_id AND gp.subject_type = 'guild'
        LEFT JOIN platform_access_subjects gs
          ON gs.connection_id = g.connection_id
          AND gs.subject_type = 'guild'
          AND gs.platform_subject_id = g.guild_id
        LEFT JOIN platform_invocation_defaults idf ON idf.connection_id = g.connection_id
      `)

      // Each statement first targets the one explicitly recorded guild, if
      // present, and otherwise the one observed guild established above. A
      // non-null recorded field supersedes only its matching legacy behavior.
      // COALESCE makes the upserts NULL-safe and protects every explicit value
      // even if this SQL is changed independently of the pre-checks later.
      yield* unsafe(`
        INSERT INTO discord_guild_channels
          (connection_id, guild_id, channel_id, invocation_mode, users_mode, reply_mode)
        SELECT cip.connection_id, rec.guild_id, cip.channel_id, cip.mode, NULL, NULL
        FROM platform_channel_invocation_policies cip
        JOIN migration_recorded_channels rec
          ON rec.connection_id = cip.connection_id AND rec.channel_id = cip.channel_id
        WHERE NOT EXISTS (
          SELECT 1 FROM migration_recorded_channels explicit
          WHERE explicit.connection_id = cip.connection_id
            AND explicit.channel_id = cip.channel_id
            AND explicit.invocation_recorded = 1
        )
          AND (
            SELECT COUNT(DISTINCT owner.guild_id)
            FROM migration_recorded_channels owner
            WHERE owner.connection_id = cip.connection_id
              AND owner.channel_id = cip.channel_id
          ) = 1
        UNION ALL
        SELECT cip.connection_id, b.guild_id, cip.channel_id, cip.mode, NULL, NULL
        FROM platform_channel_invocation_policies cip
        JOIN (${bindingLocations}) b
          ON b.connection_id = cip.connection_id AND b.channel_id = cip.channel_id
        WHERE NOT EXISTS (
          SELECT 1 FROM migration_recorded_channels rec
          WHERE rec.connection_id = cip.connection_id AND rec.channel_id = cip.channel_id
        )
        GROUP BY b.connection_id, b.guild_id, cip.channel_id
        ON CONFLICT (connection_id, guild_id, channel_id) DO UPDATE SET
          invocation_mode = COALESCE(discord_guild_channels.invocation_mode, excluded.invocation_mode)
      `)

      // Former system-management channels become reply-in-channel overrides.
      // This independently merges with legacy or recorded invocation and user
      // policy on the same channel row.
      yield* unsafe(`
        INSERT INTO discord_guild_channels
          (connection_id, guild_id, channel_id, invocation_mode, users_mode, reply_mode)
        SELECT sc.connection_id, rec.guild_id, sc.channel_id, NULL, NULL, 'reply-in-channel'
        FROM platform_system_channels sc
        JOIN migration_recorded_channels rec
          ON rec.connection_id = sc.connection_id AND rec.channel_id = sc.channel_id
        WHERE NOT EXISTS (
          SELECT 1 FROM migration_recorded_channels explicit
          WHERE explicit.connection_id = sc.connection_id
            AND explicit.channel_id = sc.channel_id
            AND explicit.reply_recorded = 1
        )
          AND (
            SELECT COUNT(DISTINCT owner.guild_id)
            FROM migration_recorded_channels owner
            WHERE owner.connection_id = sc.connection_id
              AND owner.channel_id = sc.channel_id
          ) = 1
        UNION ALL
        SELECT sc.connection_id, b.guild_id, sc.channel_id, NULL, NULL, 'reply-in-channel'
        FROM platform_system_channels sc
        JOIN (${bindingLocations}) b
          ON b.connection_id = sc.connection_id AND b.channel_id = sc.channel_id
        WHERE NOT EXISTS (
          SELECT 1 FROM migration_recorded_channels rec
          WHERE rec.connection_id = sc.connection_id AND rec.channel_id = sc.channel_id
        )
        GROUP BY b.connection_id, b.guild_id, sc.channel_id
        ON CONFLICT (connection_id, guild_id, channel_id) DO UPDATE SET
          reply_mode = COALESCE(discord_guild_channels.reply_mode, excluded.reply_mode)
      `)

      yield* unsafe(`DROP TABLE platform_system_channels`)
      yield* unsafe(`DROP TABLE platform_channel_invocation_policies`)
      yield* unsafe(`DROP TABLE platform_invocation_defaults`)
      yield* unsafe(`DROP TABLE migration_recorded_channels`)
      // Guild access policies are now expressed by each guild's enabled flag;
      // channel access policies were refused above. Only user and workspace
      // policies remain meaningful.
      yield* unsafe(`DELETE FROM platform_access_subjects WHERE subject_type = 'guild'`)
      yield* unsafe(`DELETE FROM platform_access_policies WHERE subject_type = 'guild'`)
    }),
  )
})
