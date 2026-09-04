/* oxlint-disable anti-slop/no-unsafe-dictionary-type, effecttsgo/node-builtin-import -- SQL rows are decoded immediately through Effect Schema; workspace containment uses Node's path implementation. */

import { ThreadId, type ChannelThread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import type { SqlError } from 'effect/unstable/sql/SqlError'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { ThreadPersistence } from '../conversation/ThreadPersistence.ts'
import {
  inspectRepositoryWorktree,
  removeRepositoryWorktree,
  RepositoryWorktreeError,
  RepositoryWorktreeSnapshot,
  validateRepositoryWorktreeSnapshot,
} from '../repositories/RepositoryWorktrees.ts'

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))
export const WorkspaceCleanupProposalId = NonEmptyString.pipe(
  Schema.brand('WorkspaceCleanupProposalId'),
)
export type WorkspaceCleanupProposalId = typeof WorkspaceCleanupProposalId.Type

export const WorkspaceCleanupProposal = Schema.Struct({
  id: WorkspaceCleanupProposalId,
  threadId: ThreadId,
  status: Schema.Literals(['pending', 'applied', 'stale', 'failed']),
  workspacePath: Schema.String,
  estimatedBytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  createdAt: Schema.String,
  appliedAt: Schema.NullOr(Schema.String),
  summary: Schema.String,
  resources: Schema.Array(
    Schema.Struct({
      ...RepositoryWorktreeSnapshot.fields,
      removalStatus: Schema.Literals(['pending', 'removing', 'removed']),
    }),
  ),
})
export type WorkspaceCleanupProposal = typeof WorkspaceCleanupProposal.Type

const ProposalRow = Schema.Struct({
  proposal_id: Schema.String,
  thread_id: Schema.String,
  status: Schema.String,
  lifecycle_status: Schema.String,
  workspace_path: Schema.String,
  estimated_bytes: Schema.Number,
  created_at: Schema.String,
  applied_at: Schema.NullOr(Schema.String),
  summary: Schema.String,
})
const ResourceRow = Schema.Struct({
  proposal_id: Schema.String,
  worktree_path: Schema.String,
  branch: Schema.String,
  head: Schema.String,
  common_directory: Schema.String,
  status_porcelain: Schema.String,
  size_bytes: Schema.Number,
  removal_status: Schema.String,
})
const decodeProposalRows = Schema.decodeUnknownEffect(Schema.Array(ProposalRow))
const decodeResourceRows = Schema.decodeUnknownEffect(Schema.Array(ResourceRow))
const decodeProposal = Schema.decodeUnknownEffect(WorkspaceCleanupProposal)
const decodeProposalId = Schema.decodeUnknownEffect(WorkspaceCleanupProposalId)

export class WorkspaceCleanupError extends Schema.Error<WorkspaceCleanupError>(
  'WorkspaceCleanupError',
)({
  _tag: Schema.tag('WorkspaceCleanupError'),
  operation: Schema.Literals(['inspect', 'load', 'apply', 'validate']),
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail
  }
}

/**
 * Typed rejection for an approved proposal whose owning workspace or recorded
 * worktrees changed after the proposal was created. The proposal is marked
 * `stale` transactionally before this error surfaces, so `workspace cleanup
 * list` no longer reports it pending.
 */
export class WorkspaceCleanupStaleError extends Schema.Error<WorkspaceCleanupStaleError>(
  'WorkspaceCleanupStaleError',
)({
  _tag: Schema.tag('WorkspaceCleanupStaleError'),
  proposalId: WorkspaceCleanupProposalId,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail
  }
}

export interface WorkspaceCleanupContract {
  readonly propose: (
    thread: ChannelThread,
  ) => Effect.Effect<WorkspaceCleanupProposal | null, WorkspaceCleanupError>
  readonly get: (
    proposalId: WorkspaceCleanupProposalId,
  ) => Effect.Effect<WorkspaceCleanupProposal, WorkspaceCleanupError>
  /** Lists all recorded proposals, most recently created first. */
  readonly list: () => Effect.Effect<ReadonlyArray<WorkspaceCleanupProposal>, WorkspaceCleanupError>
  readonly apply: (
    proposalId: WorkspaceCleanupProposalId,
    currentWorkingDirectory: string,
  ) => Effect.Effect<WorkspaceCleanupProposal, WorkspaceCleanupError | WorkspaceCleanupStaleError>
}

export class WorkspaceCleanup extends Context.Service<WorkspaceCleanup, WorkspaceCleanupContract>()(
  'friday/workspaces/WorkspaceCleanup',
) {}

/**
 * Guards the proposal inspection: only entries that are direct children of the
 * channel workspace (never `..`, absolute paths, or nested escapes) are
 * inspected as its repository worktrees.
 */
export const isDirectChild = (workspace: string, candidate: string): boolean => {
  const path = relative(workspace, candidate)
  return path.length > 0 && !path.startsWith('..') && !isAbsolute(path) && !path.includes('/')
}

// Stryker disable all: Proposal inspection and presentation are covered by ordinary tests; lifecycle mutation focuses on crash recovery below.
const summarize = (resources: ReadonlyArray<RepositoryWorktreeSnapshot>): string => {
  const dirty = resources.filter(({ status }) => status.length > 0).length
  const bytes = resources.reduce((total, resource) => total + resource.sizeBytes, 0)
  return `${resources.length} repository worktree${resources.length === 1 ? '' : 's'}, ${dirty} with uncommitted files, approximately ${bytes} bytes.`
}

const rowToProposal = Effect.fn('WorkspaceCleanup.rowToProposal')(function* (
  proposal: typeof ProposalRow.Type,
  resources: ReadonlyArray<typeof ResourceRow.Type>,
) {
  return yield* decodeProposal({
    id: proposal.proposal_id,
    threadId: proposal.thread_id,
    status: proposal.lifecycle_status,
    workspacePath: proposal.workspace_path,
    estimatedBytes: proposal.estimated_bytes,
    createdAt: proposal.created_at,
    appliedAt: proposal.applied_at,
    summary: proposal.summary,
    resources: resources.map((resource) => ({
      path: resource.worktree_path,
      branch: resource.branch,
      head: resource.head,
      commonDirectory: resource.common_directory,
      status: resource.status_porcelain,
      sizeBytes: resource.size_bytes,
      removalStatus: resource.removal_status,
    })),
  })
})

export const WorkspaceCleanupLive = Layer.effect(
  WorkspaceCleanup,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const fileSystem = yield* FileSystem.FileSystem
    const persistence = yield* ThreadPersistence
    const crypto = yield* Crypto.Crypto

    const get = Effect.fn('WorkspaceCleanup.get')(function* (
      proposalId: WorkspaceCleanupProposalId,
    ) {
      const proposals = yield* sql<Record<string, unknown>>`
        SELECT * FROM workspace_cleanup_proposals WHERE proposal_id = ${proposalId} LIMIT 1
      `
      const proposal = (yield* decodeProposalRows(proposals))[0]
      if (!proposal) {
        return yield* new WorkspaceCleanupError({
          operation: 'load',
          detail: `Workspace cleanup proposal '${proposalId}' was not found.`,
        })
      }
      const resources = yield* sql<Record<string, unknown>>`
        SELECT * FROM workspace_cleanup_resources
        WHERE proposal_id = ${proposalId}
        ORDER BY worktree_path
      `
      return yield* rowToProposal(proposal, yield* decodeResourceRows(resources))
    })

    const propose = Effect.fn('WorkspaceCleanup.propose')(function* (thread: ChannelThread) {
      const workspace = resolve(thread.workingDirectory)
      const entries = yield* fileSystem.readDirectory(workspace).pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceCleanupError({
              operation: 'inspect',
              detail: `Could not inspect workspace '${workspace}'.`,
              cause,
            }),
        ),
      )
      const inspected = yield* Effect.forEach(
        entries,
        (entry) => {
          const candidate = join(workspace, entry)
          if (!isDirectChild(workspace, candidate)) return Effect.succeed(null)
          return inspectRepositoryWorktree(candidate).pipe(
            Effect.mapError(
              (cause) =>
                new WorkspaceCleanupError({
                  operation: 'inspect',
                  detail: cause.message,
                  cause,
                }),
            ),
          )
        },
        { concurrency: 4 },
      )
      const resources = inspected.filter(
        (resource): resource is RepositoryWorktreeSnapshot => resource !== null,
      )
      if (resources.length === 0) return null

      const proposalId = yield* decodeProposalId(`cleanup-${yield* crypto.randomUUIDv4}`)
      const createdAt = DateTime.formatIso(yield* DateTime.now)
      const estimatedBytes = resources.reduce((total, resource) => total + resource.sizeBytes, 0)
      const summary = summarize(resources)
      const activeProposalId = yield* sql.withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly proposal_id: string }>`
            INSERT OR IGNORE INTO workspace_cleanup_proposals (
              proposal_id, thread_id, status, lifecycle_status, workspace_path, estimated_bytes,
              created_at, applied_at, summary
            ) VALUES (
              ${proposalId}, ${thread.id}, 'pending', 'pending', ${workspace}, ${estimatedBytes},
              ${createdAt}, NULL, ${summary}
            )
            RETURNING proposal_id
          `
          if (inserted.length === 0) {
            const existing = yield* sql<Record<string, unknown>>`
              SELECT * FROM workspace_cleanup_proposals
              WHERE thread_id = ${thread.id} AND lifecycle_status IN ('pending', 'failed')
              ORDER BY created_at DESC, proposal_id DESC
              LIMIT 1
            `
            const existingProposal = (yield* decodeProposalRows(existing))[0]
            if (existingProposal === undefined) {
              return yield* new WorkspaceCleanupError({
                operation: 'inspect',
                detail: `Could not resolve the active cleanup proposal for thread '${thread.id}'.`,
              })
            }
            return yield* decodeProposalId(existingProposal.proposal_id)
          }
          yield* Effect.forEach(
            resources,
            (resource) => sql`
              INSERT INTO workspace_cleanup_resources (
                proposal_id, worktree_path, branch, head, common_directory,
                status_porcelain, size_bytes, removal_status
              ) VALUES (
                ${proposalId}, ${resource.path}, ${resource.branch}, ${resource.head},
                ${resource.commonDirectory}, ${resource.status}, ${resource.sizeBytes}, 'pending'
              )
            `,
            { discard: true },
          )
          return proposalId
        }),
      )
      return yield* get(activeProposalId)
    })

    /** Marks a still-pending proposal stale inside one committed transaction. */
    const markStale = (
      proposalId: WorkspaceCleanupProposalId,
    ): Effect.Effect<void, SqlError, never> =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            UPDATE workspace_cleanup_proposals
            SET status = 'stale', lifecycle_status = 'stale'
            WHERE proposal_id = ${proposalId} AND lifecycle_status IN ('pending', 'failed')
          `
        }),
      )

    const stale = (
      proposalId: WorkspaceCleanupProposalId,
      detail: string,
    ): Effect.Effect<never, WorkspaceCleanupStaleError | SqlError> =>
      markStale(proposalId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new WorkspaceCleanupStaleError({
              proposalId,
              detail: `Workspace cleanup proposal '${proposalId}' is stale: ${detail}`,
            }),
          ),
        ),
      )

    const apply = Effect.fn('WorkspaceCleanup.apply')(function* (
      proposalId: WorkspaceCleanupProposalId,
      currentWorkingDirectory: string,
    ) {
      const proposal = yield* get(proposalId)
      if (resolve(currentWorkingDirectory) !== resolve(proposal.workspacePath)) {
        return yield* new WorkspaceCleanupError({
          operation: 'validate',
          detail: `Cleanup proposal '${proposalId}' must be applied from its owning channel workspace.`,
        })
      }
      if (proposal.status !== 'pending' && proposal.status !== 'failed') {
        return yield* new WorkspaceCleanupError({
          operation: 'validate',
          detail: `Workspace cleanup proposal '${proposalId}' is already ${proposal.status}.`,
        })
      }
      const thread = yield* persistence.getThread(proposal.threadId)
      if (Option.isNone(thread) || thread.value.audience !== 'user') {
        return yield* new WorkspaceCleanupError({
          operation: 'validate',
          detail: `Workspace cleanup proposal '${proposalId}' has no owning channel thread.`,
        })
      }
      const activeTasks = yield* persistence.listAgentThreads({ parentThreadId: proposal.threadId })
      const active = yield* Effect.filter(activeTasks, (task) =>
        persistence
          .getLatestTurn(task.id)
          .pipe(
            Effect.map(
              (latest) =>
                Option.isSome(latest) &&
                (latest.value.status === 'pending' || latest.value.status === 'running'),
            ),
          ),
      )
      if (active.length > 0) {
        return yield* new WorkspaceCleanupError({
          operation: 'validate',
          detail: 'Workspace cleanup cannot run while this channel has active tasks.',
        })
      }
      if (resolve(thread.value.workingDirectory) !== resolve(proposal.workspacePath)) {
        return yield* stale(
          proposalId,
          'the owning channel workspace changed after the proposal was created.',
        )
      }
      // Stryker restore all
      // Validate every untouched resource before deleting anything. A
      // `removing` resource has durable deletion intent, so a missing worktree
      // is the expected crash-gap state and is reconciled below.
      const pending = proposal.resources.filter((resource) => resource.removalStatus === 'pending')
      const removing = proposal.resources.filter(
        (resource) => resource.removalStatus === 'removing',
      )
      const remaining = [...pending, ...removing]
      yield* Effect.gen(function* () {
        yield* Effect.forEach(pending, validateRepositoryWorktreeSnapshot, {
          discard: true,
          concurrency: 1,
        })
        yield* Effect.forEach(
          removing,
          (resource) =>
            Effect.gen(function* () {
              const current = yield* inspectRepositoryWorktree(resource.path)
              if (current !== null) yield* validateRepositoryWorktreeSnapshot(resource)
            }),
          { discard: true, concurrency: 1 },
        )
      }).pipe(
        Effect.catch(
          (
            error,
          ): Effect.Effect<
            never,
            RepositoryWorktreeError | WorkspaceCleanupStaleError | SqlError
          > => {
            if (error.operation === 'validate') return stale(proposalId, error.message)
            return Effect.fail(error)
          },
        ),
      )
      for (const resource of remaining) {
        if (resource.removalStatus === 'pending') {
          yield* sql`
            UPDATE workspace_cleanup_resources
            SET removal_status = 'removing'
            WHERE proposal_id = ${proposalId} AND worktree_path = ${resource.path}
              AND removal_status = 'pending'
          `
        }
        const step = yield* Effect.exit(
          Effect.gen(function* () {
            yield* removeRepositoryWorktree(resource)
            yield* sql`
              UPDATE workspace_cleanup_resources
              SET removal_status = 'removed'
              WHERE proposal_id = ${proposalId} AND worktree_path = ${resource.path}
                AND removal_status = 'removing'
            `
          }),
        )
        if (step._tag === 'Failure') {
          yield* sql`
            UPDATE workspace_cleanup_proposals
            SET lifecycle_status = 'failed'
            WHERE proposal_id = ${proposalId}
          `
          return yield* Effect.failCause(step.cause)
        }
      }
      // Stryker disable all: Final projection and service error mapping are outside the deletion state machine.
      const appliedAt = DateTime.formatIso(yield* DateTime.now)
      yield* sql`
        UPDATE workspace_cleanup_proposals
        SET status = 'applied', lifecycle_status = 'applied', applied_at = ${appliedAt}
        WHERE proposal_id = ${proposalId}
      `
      return yield* get(proposalId)
    })

    const list = Effect.fn('WorkspaceCleanup.list')(function* () {
      const rows = yield* sql<Record<string, unknown>>`
        SELECT proposal_id FROM workspace_cleanup_proposals
        ORDER BY created_at DESC, proposal_id DESC
      `
      const ids = yield* Effect.forEach(rows, (row) =>
        decodeProposalId(row.proposal_id).pipe(
          Effect.mapError(
            (cause) =>
              new WorkspaceCleanupError({
                operation: 'load',
                detail: 'Stored workspace cleanup proposal identity is invalid.',
                cause,
              }),
          ),
        ),
      )
      return yield* Effect.forEach(ids, get, { concurrency: 'unbounded' })
    })

    const mapFailure =
      (operation: WorkspaceCleanupError['operation']) =>
      (cause: unknown): WorkspaceCleanupError =>
        cause instanceof WorkspaceCleanupError
          ? cause
          : new WorkspaceCleanupError({
              operation,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            })

    return WorkspaceCleanup.of({
      propose: (thread) => propose(thread).pipe(Effect.mapError(mapFailure('inspect'))),
      get: (proposalId) => get(proposalId).pipe(Effect.mapError(mapFailure('load'))),
      list: () => list().pipe(Effect.mapError(mapFailure('load'))),
      apply: (proposalId, currentWorkingDirectory) =>
        apply(proposalId, currentWorkingDirectory).pipe(
          // The typed stale outcome passes through untouched.
          Effect.mapError((cause) =>
            cause instanceof WorkspaceCleanupError || cause instanceof WorkspaceCleanupStaleError
              ? cause
              : mapFailure('apply')(cause),
          ),
          Effect.provideService(SqlClient.SqlClient, sql),
        ),
    })
  }),
)
