/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide -- Bun executes the SQLite integration boundary; the composed layer stack is the explicit test entry point. */

import { test } from 'bun:test'
import { strict as assert } from 'node:assert'
import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { WorkspaceCleanup, WorkspaceCleanupLive } from './WorkspaceCleanup.ts'
import { ThreadPersistence } from '../conversation/ThreadPersistence.ts'
import { makeSqliteThreadPersistence } from '../persistence/SqliteThreadPersistence.ts'
import { runMigrations } from '../persistence/Migrations.ts'

const SqlClientLive = SqliteClient.layer({ filename: ':memory:' })
const ThreadPersistenceLive = Layer.effect(ThreadPersistence, makeSqliteThreadPersistence()).pipe(
  Layer.provide(SqlClientLive),
)

const WorkspaceCleanupConfiguredLive = WorkspaceCleanupLive.pipe(
  Layer.provide(
    Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, BunFileSystem.layer, BunCrypto.layer),
  ),
)

const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, WorkspaceCleanup | SqlClient.SqlClient>,
) =>
  effect.pipe(
    // The test body itself issues SQL (migrations and seed rows), so the raw
    // SqlClient stays in the environment beside the service under test.
    Effect.provide(Layer.merge(WorkspaceCleanupConfiguredLive, SqlClientLive)),
    Effect.runPromise,
  )

test('lists recorded cleanup proposals most recent first with their resources', async () =>
  runWithDatabase(
    Effect.gen(function* () {
      yield* runMigrations()
      const cleanup = yield* WorkspaceCleanup
      const sql = yield* SqlClient.SqlClient
      // Proposal rows reference the owning thread.
      yield* sql`
        INSERT INTO threads (thread_id, audience, status, payload_json, created_at, updated_at)
        VALUES ('task-1', 'user', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `
      const insertProposal = (
        proposalId: string,
        createdAt: string,
        status: 'pending' | 'applied',
      ) =>
        sql`
          INSERT INTO workspace_cleanup_proposals (
            proposal_id, thread_id, status, lifecycle_status, workspace_path, estimated_bytes,
            created_at, applied_at, summary
          ) VALUES (
            ${proposalId}, 'task-1', ${status}, ${status}, '/tmp/channel', 4096,
            ${createdAt}, ${status === 'applied' ? '2025-01-02T00:00:00Z' : null},
            '1 repository worktree, 0 with uncommitted files, approximately 4096 bytes.'
          )
        `
      const insertResource = (proposalId: string, path: string) =>
        sql`
          INSERT INTO workspace_cleanup_resources (
            proposal_id, worktree_path, branch, head, common_directory,
            status_porcelain, size_bytes
          ) VALUES (
            ${proposalId}, ${path}, 'friday/channel/abc123', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
            '/home/friday/.friday/repositories/cache.git', '', 4096
          )
        `
      yield* insertProposal('cleanup-old', '2025-01-01T00:00:00Z', 'applied').pipe(
        Effect.andThen(insertResource('cleanup-old', '/tmp/channel/older-repo')),
      )
      yield* insertProposal('cleanup-new', '2025-01-03T00:00:00Z', 'pending').pipe(
        Effect.andThen(insertResource('cleanup-new', '/tmp/channel/newer-repo')),
      )

      const proposals = yield* cleanup.list()
      assert.deepStrictEqual(
        proposals.map((proposal) => proposal.id),
        ['cleanup-new', 'cleanup-old'],
      )
      assert.deepStrictEqual(
        proposals.map((proposal) => proposal.status),
        ['pending', 'applied'],
      )
      assert.strictEqual(proposals[0]!.threadId, 'task-1')
      assert.deepStrictEqual(
        proposals[0]!.resources.map((resource) => resource.path),
        ['/tmp/channel/newer-repo'],
      )
      assert.strictEqual(proposals[0]!.resources[0]!.sizeBytes, 4096)
      assert.strictEqual(proposals[0]!.resources[0]!.removalStatus, 'pending')
      assert.strictEqual(proposals[0]!.appliedAt, null)
      assert.strictEqual(proposals[1]!.appliedAt, '2025-01-02T00:00:00Z')
    }),
  ))
