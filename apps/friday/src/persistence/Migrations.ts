import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runChatSdkStateMigrations } from '../platforms/chat-sdk/SqliteChatStateAdapter.ts'

export const runMigrations = Effect.fn('runMigrations')(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`PRAGMA foreign_keys = ON`
  yield* runChatSdkStateMigrations()

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
      FOREIGN KEY (connection_id) REFERENCES platform_connections(connection_id) ON DELETE CASCADE
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS platform_invocation_defaults (
      connection_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK (mode IN ('mention-only', 'all-messages')),
      FOREIGN KEY (connection_id) REFERENCES platform_connections(connection_id) ON DELETE CASCADE
    )
  `

  yield* sql`
    INSERT OR IGNORE INTO platform_invocation_defaults (connection_id, mode)
    SELECT connection_id, 'all-messages'
    FROM discord_connections
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS platform_channel_invocation_policies (
      connection_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('mention-only', 'all-messages')),
      PRIMARY KEY (connection_id, channel_id),
      FOREIGN KEY (connection_id) REFERENCES platform_connections(connection_id) ON DELETE CASCADE
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
      subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'channel', 'guild', 'workspace')),
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
