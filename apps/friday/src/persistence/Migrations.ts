import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runChatSdkStateMigrations } from '../surfaces/chat-sdk/SqliteChatStateAdapter.ts'

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

  // Rename the original messaging-platform vocabulary in durable JSON. SQLite's
  // json_set/json_remove functions preserve all unrelated aggregate fields.
  yield* sql`
    UPDATE threads
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.surfaceBinding',
        json_object(
          'surface', json_extract(payload_json, '$.externalBinding.platform'),
          'channelId', json_extract(payload_json, '$.externalBinding.channelId'),
          'sourceMessageId', json_extract(payload_json, '$.externalBinding.sourceMessageId'),
          'conversationId', json_extract(payload_json, '$.externalBinding.externalThreadId')
        )
      ),
      '$.externalBinding'
    )
    WHERE json_type(payload_json, '$.externalBinding') = 'object'
      AND json_type(payload_json, '$.surfaceBinding') IS NULL
  `

  yield* sql`
    UPDATE threads
    SET payload_json = json_remove(
      json_set(payload_json, '$.surfaceBinding', json('null')),
      '$.externalBinding'
    )
    WHERE json_type(payload_json, '$.externalBinding') = 'null'
      AND json_type(payload_json, '$.surfaceBinding') IS NULL
  `

  yield* sql`
    UPDATE turns
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.input.surfaceMessageId',
        json_extract(payload_json, '$.input.externalMessageId')
      ),
      '$.input.externalMessageId'
    )
    WHERE json_type(payload_json, '$.input.externalMessageId') IS NOT NULL
      AND json_type(payload_json, '$.input.surfaceMessageId') IS NULL
  `

  yield* sql`
    UPDATE activities
    SET payload_json = json_remove(
      json_set(
        payload_json,
        '$.message.surfaceMessageId',
        json_extract(payload_json, '$.message.externalMessageId')
      ),
      '$.message.externalMessageId'
    )
    WHERE type = 'steering'
      AND json_type(payload_json, '$.message.externalMessageId') IS NOT NULL
      AND json_type(payload_json, '$.message.surfaceMessageId') IS NULL
  `
})
