import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runChatSdkStateMigrations } from '../platforms/chat-sdk/SqliteChatStateAdapter.ts'

export const runMigrations = Effect.fn('runMigrations')(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`PRAGMA foreign_keys = ON`
  yield* runChatSdkStateMigrations()

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
