/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide, effecttsgo/process-env, effecttsgo/global-random -- This vitest suite exercises the real SQLite, filesystem, git, and worktree-registry boundary; FRIDAY_HOME must be isolated before module import. */

import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import { AgentThread, ChannelThread, ThreadId, Turn, TurnId } from '@friday/contracts/conversation'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { execFile } from 'node:child_process'
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { vi } from 'vitest'

import { ThreadPersistence } from '../conversation/ThreadPersistence.ts'
import { makeSqliteThreadPersistence } from '../persistence/SqliteThreadPersistence.ts'
import {
  ensureRepositoryWorktree,
  listManagedWorktrees,
  RepositoryUrl,
  worktreeRegistryPath,
} from '../repositories/RepositoryWorktrees.ts'
import {
  isDirectChild,
  WorkspaceCleanup,
  WorkspaceCleanupLive,
  WorkspaceCleanupError,
  WorkspaceCleanupProposalId,
  WorkspaceCleanupStaleError,
} from './WorkspaceCleanup.ts'

const decodeRepositoryUrlSync = Schema.decodeSync(RepositoryUrl)
const decodeCleanupProposalId = Schema.decodeSync(WorkspaceCleanupProposalId)
const isStaleError = Schema.is(WorkspaceCleanupStaleError)
const isCleanupError = Schema.is(WorkspaceCleanupError)
const decodeTurn = Schema.decodeSync(Turn)
const encodeTurnJson = Schema.encodeSync(Schema.fromJsonString(Turn))
const decodeAgentThread = Schema.decodeSync(AgentThread)
const decodeThreadId = Schema.decodeSync(ThreadId)
const decodeTurnId = Schema.decodeSync(TurnId)

// The service under test touches Friday's worktree registry through the
// module-level default home, so the whole suite runs against an isolated
// temporary home that is set before any module import runs.
const fridayHome = vi.hoisted(() => {
  const base = process.env.TMPDIR ?? '/tmp'
  const home = `${base}/friday-cleanup-vitest-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`
  process.env.FRIDAY_HOME = home
  return home
})

const exec = promisify(execFile)

const SqlClientLive = SqliteClient.layer({ filename: ':memory:' })
const ThreadPersistenceLive = Layer.effect(ThreadPersistence, makeSqliteThreadPersistence()).pipe(
  Layer.provide(SqlClientLive),
)
const TestLive = WorkspaceCleanupLive.pipe(
  Layer.provide(
    Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, NodeFileSystem.layer, NodeCrypto.layer),
  ),
)

const decodeThread = Schema.decodeSync(ChannelThread)
const encodeThreadJson = Schema.encodeSync(Schema.fromJsonString(ChannelThread))

const makeThread = (workingDirectory: string) =>
  decodeThread({
    id: 'thread-cleanup',
    audience: 'user',
    parent: null,
    harness: 'pi',
    harnessSession: null,
    workingDirectory,
    model: { provider: 'anthropic', modelId: 'claude-sonnet' },
    thinkingLevel: 'medium',
    channelContext: { name: 'Cleanup test channel', description: '' },
    conversationBinding: {
      platform: 'discord',
      connectionId: 'discord',
      channelId: 'channel-1',
      sourceMessageId: 'message-1',
      conversationId: 'conversation-1',
    },
    status: 'active',
    createdAt: '2026-03-21T09:00:00.000Z',
    updatedAt: '2026-03-21T09:00:00.000Z',
    closedAt: null,
  })

const git = async (cwd: string, ...arguments_: ReadonlyArray<string>) => {
  await exec('git', [...arguments_], { cwd })
}

const commitAll = async (cwd: string, message: string) => {
  await exec('git', ['add', '-A'], { cwd })
  await exec(
    'git',
    ['-c', 'user.name=Friday', '-c', 'user.email=friday@example.com', 'commit', '-m', message],
    { cwd },
  )
}

/** Builds a channel workspace holding one Friday-managed repository worktree. */
const makeManagedWorkspace = (name: string) =>
  Effect.gen(function* () {
    const root = join(fridayHome, 'workspaces', name)
    const workspace = join(root, 'workspace')
    const source = join(root, 'source')
    yield* Effect.promise(() => mkdir(source, { recursive: true }))
    yield* Effect.promise(() => writeFile(join(source, 'README.md'), `${name}\n`, 'utf8'))
    yield* Effect.promise(() => git(source, 'init', '--initial-branch=main'))
    yield* Effect.promise(() => commitAll(source, 'initial'))
    const url = decodeRepositoryUrlSync(source)
    const worktree = yield* ensureRepositoryWorktree({ url, workspaceRoot: workspace })
    return { workspace, worktree }
  })

/** Seeds the owning channel thread and proposes cleanup for its workspace. */
const proposeForWorkspace = (workspace: string) =>
  Effect.gen(function* () {
    const persistence = yield* ThreadPersistence
    yield* persistence.createThread(makeThread(workspace))
    const cleanup = yield* WorkspaceCleanup
    return yield* cleanup.propose(makeThread(workspace))
  })

describe('WorkspaceCleanup', () => {
  it.effect('proposes and applies a fresh proposal, removing and unregistering its worktree', () =>
    Effect.gen(function* () {
      const { workspace, worktree } = yield* makeManagedWorkspace('apply-fresh')
      // Non-git entries in the workspace are ignored by the inspection.
      yield* Effect.promise(() => writeFile(join(workspace, 'notes.txt'), 'notes', 'utf8'))
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)
      assert.strictEqual(proposal.status, 'pending')
      assert.deepStrictEqual(
        proposal.resources.map((resource) => resource.path),
        [worktree.path],
      )
      assert.match(
        proposal.summary,
        /^1 repository worktree, 0 with uncommitted files, approximately \d+ bytes\.$/,
      )
      // An unchanged workspace re-proposes the same pending proposal.
      const again = yield* cleanup.propose(makeThread(workspace))
      assert(again !== null)
      assert.strictEqual(again.id, proposal.id)

      const applied = yield* cleanup.apply(proposal.id, workspace)
      assert.strictEqual(applied.status, 'applied')
      assert(applied.appliedAt !== null)

      // The worktree is gone on disk and no longer registered with Friday.
      assert(
        yield* Effect.promise(() =>
          stat(worktree.path).then(
            () => false,
            () => true,
          ),
        ),
      )
      assert.deepStrictEqual(yield* listManagedWorktrees(), [])
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('marks a proposal stale when the owning workspace changed before apply', () =>
    Effect.gen(function* () {
      const { workspace } = yield* makeManagedWorkspace('stale-workspace')
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)

      // The channel moved to a different working directory after approval.
      const moved = makeThread(join(fridayHome, 'workspaces', 'moved-elsewhere'))
      const sql = yield* SqlClient.SqlClient
      yield* sql`
          UPDATE threads
          SET payload_json = ${encodeThreadJson(moved)}
          WHERE thread_id = 'thread-cleanup'
        `

      const stale = yield* cleanup.apply(proposal.id, workspace).pipe(Effect.flip)
      assert(isStaleError(stale))
      assert.match(stale.message, /is stale/)
      assert.match(stale.message, /workspace changed/)

      const recorded = yield* cleanup.get(proposal.id)
      assert.strictEqual(recorded.status, 'stale')
      const listed = yield* cleanup.list()
      assert.deepStrictEqual(
        listed.map((entry) => [entry.id, entry.status]),
        [[proposal.id, 'stale']],
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('marks a proposal stale when a worktree changed after approval', () =>
    Effect.gen(function* () {
      const { workspace, worktree } = yield* makeManagedWorkspace('stale-worktree')
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)

      // The worktree gains uncommitted files after the snapshot was taken.
      yield* Effect.promise(() => writeFile(join(worktree.path, 'late.txt'), 'late\n', 'utf8'))

      const stale = yield* cleanup.apply(proposal.id, workspace).pipe(Effect.flip)
      assert(isStaleError(stale))
      assert.match(stale.message, /changed after cleanup approval was requested/)

      const recorded = yield* cleanup.get(proposal.id)
      assert.strictEqual(recorded.status, 'stale')
      // The changed worktree itself is untouched on disk.
      assert(
        yield* Effect.promise(() =>
          stat(worktree.path).then(
            () => true,
            () => false,
          ),
        ),
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('validates every resource before removing any worktree', () =>
    Effect.gen(function* () {
      const { workspace, worktree: first } = yield* makeManagedWorkspace('all-or-nothing')
      const secondSource = join(fridayHome, 'workspaces', 'all-or-nothing-second')
      yield* Effect.promise(() => mkdir(secondSource, { recursive: true }))
      yield* Effect.promise(() => writeFile(join(secondSource, 'README.md'), 'second\n', 'utf8'))
      yield* Effect.promise(() => git(secondSource, 'init', '--initial-branch=main'))
      yield* Effect.promise(() => commitAll(secondSource, 'initial'))
      const second = yield* ensureRepositoryWorktree({
        url: decodeRepositoryUrlSync(secondSource),
        workspaceRoot: workspace,
      })
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)
      assert.strictEqual(proposal.resources.length, 2)

      // Make the later resource stale. Apply must not remove the earlier one
      // before discovering this mismatch.
      const later = proposal.resources[1]!
      yield* Effect.promise(() => writeFile(join(later.path, 'late.txt'), 'late\n', 'utf8'))
      const error = yield* cleanup.apply(proposal.id, workspace).pipe(Effect.flip)
      assert(isStaleError(error))
      for (const path of [first.path, second.path]) {
        assert(
          yield* Effect.promise(() =>
            stat(path).then(
              () => true,
              () => false,
            ),
          ),
        )
      }
      assert.strictEqual((yield* cleanup.get(proposal.id)).status, 'stale')
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('records partial progress as failed and resumes after registry recovery', () =>
    Effect.gen(function* () {
      const { workspace, worktree: first } = yield* makeManagedWorkspace('resume-failure')
      const otherSource = join(fridayHome, 'workspaces', 'resume-failure-other')
      yield* Effect.promise(() => mkdir(otherSource, { recursive: true }))
      yield* Effect.promise(() => writeFile(join(otherSource, 'README.md'), 'other', 'utf8'))
      yield* Effect.promise(() => git(otherSource, 'init', '--initial-branch=main'))
      yield* Effect.promise(() => commitAll(otherSource, 'initial'))
      const second = yield* ensureRepositoryWorktree({
        url: decodeRepositoryUrlSync(otherSource),
        workspaceRoot: workspace,
      })
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)
      assert.strictEqual(proposal.resources.length, 2)

      const registry = worktreeRegistryPath(fridayHome)
      const backup = `${registry}.backup`
      yield* Effect.promise(() => rename(registry, backup))
      yield* Effect.promise(() => mkdir(registry))
      const failure = yield* cleanup.apply(proposal.id, workspace).pipe(Effect.flip)
      assert(isCleanupError(failure))
      const failed = yield* cleanup.get(proposal.id)
      assert.strictEqual(failed.status, 'failed')
      assert.deepStrictEqual(
        failed.resources.map((resource) => resource.removalStatus),
        ['removing', 'pending'],
      )
      const removedFirst = proposal.resources[0]!.path
      const untouchedSecond = proposal.resources[1]!.path
      assert.strictEqual(
        yield* Effect.promise(() =>
          stat(removedFirst).then(
            () => false,
            () => true,
          ),
        ),
        true,
      )
      assert.strictEqual(
        yield* Effect.promise(() =>
          stat(untouchedSecond).then(
            () => true,
            () => false,
          ),
        ),
        true,
      )

      yield* Effect.promise(() => rm(registry, { recursive: true, force: true }))
      yield* Effect.promise(() => rename(backup, registry))
      const applied = yield* cleanup.apply(proposal.id, workspace)
      assert.strictEqual(applied.status, 'applied')
      assert.deepStrictEqual(
        applied.resources.map((resource) => resource.removalStatus),
        ['removed', 'removed'],
      )
      const listedPaths = (yield* listManagedWorktrees()).map((entry) => entry.path)
      assert.strictEqual(listedPaths.includes(first.path), false)
      assert.strictEqual(listedPaths.includes(second.path), false)
      assert(new Set([first.path, second.path]).has(removedFirst))
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('does not reprocess resources already recorded as removed', () =>
    Effect.gen(function* () {
      const { workspace, worktree } = yield* makeManagedWorkspace('skip-removed')
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        UPDATE workspace_cleanup_resources
        SET removal_status = 'removed'
        WHERE proposal_id = ${proposal.id} AND worktree_path = ${worktree.path}
      `

      const applied = yield* cleanup.apply(proposal.id, workspace)
      assert.strictEqual(applied.status, 'applied')
      assert.strictEqual(applied.resources[0]!.removalStatus, 'removed')
      assert.strictEqual(
        yield* Effect.promise(() =>
          stat(worktree.path).then(
            () => true,
            () => false,
          ),
        ),
        true,
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('does not repeat the durable-intent transition for removing resources', () =>
    Effect.gen(function* () {
      const { workspace, worktree } = yield* makeManagedWorkspace('keep-removing-intent')
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        UPDATE workspace_cleanup_resources
        SET removal_status = 'removing'
        WHERE proposal_id = ${proposal.id} AND worktree_path = ${worktree.path}
      `
      yield* sql`
        CREATE TRIGGER reject_repeated_removing
        BEFORE UPDATE OF removal_status ON workspace_cleanup_resources
        WHEN OLD.removal_status = 'removing' AND NEW.removal_status = 'removing'
        BEGIN
          SELECT RAISE(ABORT, 'repeated durable intent');
        END
      `

      const applied = yield* cleanup.apply(proposal.id, workspace)
      assert.strictEqual(applied.status, 'applied')
      assert.strictEqual(applied.resources[0]!.removalStatus, 'removed')
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('reconciles a hard crash after deletion and before completion persistence', () =>
    Effect.gen(function* () {
      const { workspace, worktree } = yield* makeManagedWorkspace('resume-crash-gap')
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)
      const sql = yield* SqlClient.SqlClient

      yield* sql`
        UPDATE workspace_cleanup_resources
        SET removal_status = 'removing'
        WHERE proposal_id = ${proposal.id} AND worktree_path = ${worktree.path}
      `
      yield* Effect.promise(() =>
        exec('git', [
          '--git-dir',
          worktree.commonDirectory,
          'worktree',
          'remove',
          '--force',
          worktree.path,
        ]),
      )

      const resumed = yield* cleanup.apply(proposal.id, workspace)
      assert.strictEqual(resumed.status, 'applied')
      assert.strictEqual(resumed.resources[0]!.removalStatus, 'removed')
      assert.strictEqual(
        (yield* listManagedWorktrees()).some((entry) => entry.path === worktree.path),
        false,
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('applies only from the owning workspace', () =>
    Effect.gen(function* () {
      const { workspace } = yield* makeManagedWorkspace('wrong-cwd')
      const cleanup = yield* WorkspaceCleanup
      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)

      const refused = yield* cleanup
        .apply(proposal.id, join(fridayHome, 'workspaces', 'other-place'))
        .pipe(Effect.flip)
      assert.match(refused.message, /must be applied from its owning channel workspace/)
      // A wrong working directory is an operator error, not staleness.
      const recorded = yield* cleanup.get(proposal.id)
      assert.strictEqual(recorded.status, 'pending')
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('summarizes multiple worktrees and their uncommitted files', () =>
    Effect.gen(function* () {
      const { workspace, worktree } = yield* makeManagedWorkspace('summary')
      // A second Friday-managed worktree in the same workspace, dirty on disk.
      const otherSource = join(fridayHome, 'workspaces', 'summary-other-source')
      yield* Effect.promise(() => mkdir(otherSource, { recursive: true }))
      yield* Effect.promise(() => writeFile(join(otherSource, 'README.md'), 'other\n', 'utf8'))
      yield* Effect.promise(() => git(otherSource, 'init', '--initial-branch=main'))
      yield* Effect.promise(() => commitAll(otherSource, 'initial'))
      const second = yield* ensureRepositoryWorktree({
        url: decodeRepositoryUrlSync(otherSource),
        workspaceRoot: workspace,
      })
      yield* Effect.promise(() => writeFile(join(second.path, 'dirty.txt'), 'dirty\n', 'utf8'))

      const proposal = yield* proposeForWorkspace(workspace)
      assert(proposal !== null)
      assert.deepStrictEqual(
        proposal.resources.map((resource) => resource.path),
        [worktree.path, second.path].toSorted(),
      )
      assert.match(
        proposal.summary,
        /^2 repository worktrees, 1 with uncommitted files, approximately \d+ bytes\.$/,
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('inspects only direct children of the workspace', () =>
    Effect.sync(() => {
      assert.strictEqual(isDirectChild('/workspace', '/workspace/repo'), true)
      assert.strictEqual(isDirectChild('/workspace', '/workspace/sub/repo'), false)
      assert.strictEqual(isDirectChild('/workspace', '/elsewhere/repo'), false)
      assert.strictEqual(isDirectChild('/workspace', '/workspace'), false)
      assert.strictEqual(isDirectChild('/workspace', '/workspace/../elsewhere'), false)
      assert.strictEqual(isDirectChild('/workspace', '/workspace/./repo'), true)
      assert.strictEqual(isDirectChild('/workspace', '/workspace/x..'), true)
      assert.strictEqual(isDirectChild('/workspace', 'relative'), false)
      assert.strictEqual(isDirectChild('/workspace', ''), false)
    }),
  )

  it.effect('fails typed when the workspace cannot be inspected or a child is broken', () =>
    Effect.gen(function* () {
      const cleanup = yield* WorkspaceCleanup
      // A workspace directory that does not exist fails the inspection.
      const missing = yield* cleanup
        .propose(makeThread(join(fridayHome, 'workspaces', 'nope', 'missing')))
        .pipe(Effect.flip)
      assert(isCleanupError(missing))
      assert.strictEqual(missing.operation, 'inspect')
      assert.strictEqual(
        missing.message,
        `Could not inspect workspace '${join(fridayHome, 'workspaces', 'nope', 'missing')}'.`,
      )

      // A repository child whose head cannot be resolved fails per entry.
      const brokenWorkspace = join(fridayHome, 'workspaces', 'broken-child', 'workspace')
      const brokenRepo = join(brokenWorkspace, 'broken-repo')
      yield* Effect.promise(() => mkdir(brokenRepo, { recursive: true }))
      yield* Effect.promise(() => git(brokenRepo, 'init', '--initial-branch=main'))
      const broken = yield* cleanup.propose(makeThread(brokenWorkspace)).pipe(Effect.flip)
      assert(isCleanupError(broken))
      assert.strictEqual(broken.operation, 'inspect')
      assert(broken.cause !== undefined)
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('refuses to apply a proposal twice, with a missing thread, or with active tasks', () =>
    Effect.gen(function* () {
      const { workspace } = yield* makeManagedWorkspace('apply-twice')
      const cleanup = yield* WorkspaceCleanup
      const persistence = yield* ThreadPersistence
      yield* persistence.createThread(makeThread(workspace))
      const proposal = yield* cleanup.propose(makeThread(workspace))
      assert(proposal !== null)

      const applied = yield* cleanup.apply(proposal.id, workspace)
      assert.strictEqual(applied.status, 'applied')
      const second = yield* cleanup.apply(proposal.id, workspace).pipe(Effect.flip)
      assert(isCleanupError(second))
      assert.match(second.message, /already applied/)

      // A proposal owned by an agent thread is not a channel cleanup.
      const sql = yield* SqlClient.SqlClient
      const agentThread = decodeAgentThread({
        id: 'thread-agent',
        audience: 'agent',
        parent: { threadId: 'thread-cleanup', turnId: 'turn-1' },
        harness: 'pi',
        harnessSession: null,
        workingDirectory: workspace,
        model: { provider: 'anthropic', modelId: 'claude-sonnet' },
        thinkingLevel: 'medium',
        role: 'subagent',
        conversationBinding: null,
        status: 'active',
        createdAt: '2026-03-21T09:05:00.000Z',
        updatedAt: '2026-03-21T09:05:00.000Z',
        closedAt: null,
      })
      yield* persistence.createThread(agentThread)
      yield* sql`
          INSERT INTO workspace_cleanup_proposals (
            proposal_id, thread_id, status, workspace_path, estimated_bytes,
            created_at, applied_at, summary
          ) VALUES (
            'cleanup-orphan', 'thread-agent', 'pending', ${workspace}, 0,
            '2026-01-01T00:00:00.000Z', NULL, 'agent-owned proposal.'
          )
        `
      const orphan = yield* cleanup
        .apply(decodeCleanupProposalId('cleanup-orphan'), workspace)
        .pipe(Effect.flip)
      assert(isCleanupError(orphan))
      assert.match(orphan.message, /has no owning channel thread/)
      const orphaned = yield* cleanup.get(decodeCleanupProposalId('cleanup-orphan'))
      assert.strictEqual(orphaned.status, 'pending')

      // An active agent task in the channel blocks cleanup. The earlier
      // apply removed the first worktree, so ensure a fresh one to propose.
      yield* ensureRepositoryWorktree({
        url: decodeRepositoryUrlSync(join(fridayHome, 'workspaces', 'apply-twice', 'source')),
        workspaceRoot: workspace,
      })
      const runningTurn = decodeTurn({
        id: 'turn-1',
        threadId: 'thread-agent',
        sequence: 1,
        input: { source: 'user', content: { text: 'Run', images: [] } },
        agentMessage: null,
        activities: [],
        model: { provider: 'anthropic', modelId: 'claude-sonnet' },
        thinkingLevel: 'medium',
        harnessTurnId: null,
        status: 'running',
        requestedAt: '2026-03-21T10:00:00.000Z',
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        usage: null,
      })
      yield* persistence.createTurn(runningTurn)
      const fresh = yield* cleanup.propose(makeThread(workspace))
      assert(fresh !== null)
      const blocked = yield* cleanup.apply(fresh.id, workspace).pipe(Effect.flip)
      assert(isCleanupError(blocked))
      assert.match(blocked.message, /active tasks/)

      // A completed task does not block; an idle agent task does neither.
      const completed = Turn.make({
        ...runningTurn,
        status: 'completed',
        agentMessage: 'done',
        completedAt: '2026-03-21T10:05:00.000Z',
      })
      yield* sql`UPDATE turns SET payload_json = ${encodeTurnJson(completed)} WHERE turn_id = 'turn-1'`
      yield* persistence.createThread(
        AgentThread.make({
          ...agentThread,
          id: decodeThreadId('thread-agent-idle'),
          parent: {
            threadId: decodeThreadId('thread-cleanup'),
            turnId: decodeTurnId('turn-2'),
          },
        }),
      )
      const settled = yield* cleanup.propose(makeThread(workspace))
      assert(settled !== null)
      const unblocked = yield* cleanup.apply(settled.id, workspace)
      assert.strictEqual(unblocked.status, 'applied')
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('reports corrupted identities and missing proposals as typed load errors', () =>
    Effect.gen(function* () {
      const { workspace } = yield* makeManagedWorkspace('corrupt-rows')
      const cleanup = yield* WorkspaceCleanup
      const persistence = yield* ThreadPersistence
      yield* persistence.createThread(makeThread(workspace))
      const sql = yield* SqlClient.SqlClient
      yield* sql`
          INSERT INTO workspace_cleanup_proposals (
            proposal_id, thread_id, status, workspace_path, estimated_bytes,
            created_at, applied_at, summary
          ) VALUES (
            '', 'thread-cleanup', 'pending', ${workspace}, 0,
            '2026-01-01T00:00:00.000Z', NULL, 'corrupt identity.'
          )
        `
      const loadFailure = yield* cleanup.list().pipe(Effect.flip)
      assert(isCleanupError(loadFailure))
      assert.strictEqual(loadFailure.operation, 'load')
      assert.strictEqual(
        loadFailure.message,
        'Stored workspace cleanup proposal identity is invalid.',
      )

      const missing = yield* cleanup
        .apply(decodeCleanupProposalId('cleanup-nope'), workspace)
        .pipe(Effect.flip)
      assert(isCleanupError(missing))
      assert.strictEqual(missing.operation, 'load')
      assert.strictEqual(
        missing.message,
        "Workspace cleanup proposal 'cleanup-nope' was not found.",
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.effect('proposes nothing without repository worktrees and refuses unknown proposals', () =>
    Effect.gen(function* () {
      const workspace = join(fridayHome, 'workspaces', 'empty', 'workspace')
      yield* Effect.promise(() => mkdir(workspace, { recursive: true }))
      const cleanup = yield* WorkspaceCleanup
      assert.strictEqual(yield* cleanup.propose(makeThread(workspace)), null)
      assert.deepStrictEqual(yield* cleanup.list(), [])
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SqlClientLive, ThreadPersistenceLive, TestLive)),
    ),
  )

  it.afterAll?.(async () => {
    await rm(fridayHome, { recursive: true, force: true }).catch(() => undefined)
  })
})
