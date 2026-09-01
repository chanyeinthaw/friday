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
    return `Legacy Discord configuration migration refused: ${this.detail}. The migration rolled back and the legacy tables are unchanged; resolve these rows (or record the equivalent guild configuration), then restart Friday.`
  }
}

export const runMigrations = Effect.fn('runMigrations')(function* () {
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

  yield* migrateConnectionScopedDiscordConfig()

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
      workspace_path TEXT NOT NULL,
      estimated_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      applied_at TEXT,
      summary TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(thread_id)
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_cleanup_resources (
      proposal_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      head TEXT NOT NULL,
      common_directory TEXT NOT NULL,
      status_porcelain TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      PRIMARY KEY (proposal_id, worktree_path),
      FOREIGN KEY (proposal_id) REFERENCES workspace_cleanup_proposals(proposal_id) ON DELETE CASCADE
    )
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
    SET payload_json = json_set(payload_json, '$.channelRole', 'channel')
    WHERE audience = 'user'
      AND json_extract(payload_json, '$.channelRole') IS NULL
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
 */
const migrateConnectionScopedDiscordConfig = Effect.fn('migrateConnectionScopedDiscordConfig')(
  function* () {
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

        // A channel observed under more than one guild has ambiguous ownership;
        // the migration never guesses which guild a policy belongs to.
        const ambiguous = yield* unsafe<{
          readonly connection_id: string
          readonly channel_id: string
          readonly guild_count: number
        }>(`
        SELECT connection_id, channel_id, COUNT(DISTINCT guild_id) AS guild_count
        FROM (${bindingLocations}) b
        GROUP BY b.connection_id, b.channel_id
        HAVING COUNT(DISTINCT guild_id) > 1
      `)
        for (const row of ambiguous) {
          problems.push(
            `channel ${row.channel_id} on connection ${row.connection_id} is bound under ${row.guild_count} guilds`,
          )
        }

        // Legacy channel rows whose guild is not observable from persisted
        // bindings cannot be placed; dropping them would silently discard a
        // restrictive policy, so the operator decides instead.
        const unmappedRows = (source: string, table: string) =>
          unsafe<{ readonly connection_id: string; readonly channel_id: string }>(`
        SELECT ${table}.connection_id AS connection_id, ${table}.channel_id AS channel_id
        FROM ${table}
        WHERE NOT EXISTS (
          SELECT 1 FROM (${bindingLocations}) b
          WHERE b.connection_id = ${table}.connection_id AND b.channel_id = ${table}.channel_id
        )
      `).pipe(
            Effect.map((rows) =>
              rows.map(
                (row) =>
                  `channel ${row.channel_id} on connection ${row.connection_id} (${source}) has no observable guild`,
              ),
            ),
          )
        problems.push(
          ...(yield* unmappedRows(
            'channel invocation policy',
            'platform_channel_invocation_policies',
          )),
          ...(yield* unmappedRows('system channel', 'platform_system_channels')),
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
            `connection ${row.connection_id} has channel access policies, which have no per-channel equivalent in the guild model`,
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

        // Channel invocation overrides migrate under the channel's observed
        // guild. The upsert only touches the invocation column so rows created
        // by a later statement keep their other overrides.
        yield* unsafe(`
        INSERT INTO discord_guild_channels
          (connection_id, guild_id, channel_id, invocation_mode, users_mode, reply_mode)
        SELECT b.connection_id, b.guild_id, cip.channel_id, cip.mode, NULL, NULL
        FROM platform_channel_invocation_policies cip
        JOIN (${bindingLocations}) b
          ON b.connection_id = cip.connection_id AND b.channel_id = cip.channel_id
        GROUP BY b.connection_id, b.guild_id, cip.channel_id
        ON CONFLICT (connection_id, guild_id, channel_id) DO UPDATE SET
          invocation_mode = excluded.invocation_mode
      `)

        // Former system-management channels become reply-in-channel overrides,
        // merged into any override row the same channel already carries (a
        // channel that is both an invocation override and a system channel
        // keeps both semantics).
        yield* unsafe(`
        INSERT INTO discord_guild_channels
          (connection_id, guild_id, channel_id, invocation_mode, users_mode, reply_mode)
        SELECT b.connection_id, b.guild_id, sc.channel_id, NULL, NULL, 'reply-in-channel'
        FROM platform_system_channels sc
        JOIN (${bindingLocations}) b
          ON b.connection_id = sc.connection_id AND b.channel_id = sc.channel_id
        GROUP BY b.connection_id, b.guild_id, sc.channel_id
        ON CONFLICT (connection_id, guild_id, channel_id) DO UPDATE SET
          reply_mode = excluded.reply_mode
      `)

        yield* unsafe(`DROP TABLE platform_system_channels`)
        yield* unsafe(`DROP TABLE platform_channel_invocation_policies`)
        yield* unsafe(`DROP TABLE platform_invocation_defaults`)
        // Guild access policies are now expressed by each guild's enabled flag;
        // channel access policies were refused above. Only user and workspace
        // policies remain meaningful.
        yield* unsafe(`DELETE FROM platform_access_subjects WHERE subject_type = 'guild'`)
        yield* unsafe(`DELETE FROM platform_access_policies WHERE subject_type = 'guild'`)
      }),
    )
  },
)
