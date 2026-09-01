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
import { isAbsolute, join, relative, resolve } from 'node:path'

import { ThreadPersistence } from '../conversation/ThreadPersistence.ts'
import {
  inspectRepositoryWorktree,
  removeRepositoryWorktree,
  RepositoryWorktreeSnapshot,
} from '../repositories/RepositoryWorktrees.ts'

const NonEmptyString = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))
export const WorkspaceCleanupProposalId = NonEmptyString.pipe(
  Schema.brand('WorkspaceCleanupProposalId'),
)
export type WorkspaceCleanupProposalId = typeof WorkspaceCleanupProposalId.Type

export const WorkspaceCleanupProposal = Schema.Struct({
  id: WorkspaceCleanupProposalId,
  threadId: ThreadId,
  status: Schema.Literals(['pending', 'applied', 'stale']),
  workspacePath: Schema.String,
  estimatedBytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  createdAt: Schema.String,
  appliedAt: Schema.NullOr(Schema.String),
  summary: Schema.String,
  resources: Schema.Array(RepositoryWorktreeSnapshot),
})
export type WorkspaceCleanupProposal = typeof WorkspaceCleanupProposal.Type

const ProposalRow = Schema.Struct({
  proposal_id: Schema.String,
  thread_id: Schema.String,
  status: Schema.String,
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
  ) => Effect.Effect<WorkspaceCleanupProposal, WorkspaceCleanupError>
}

export class WorkspaceCleanup extends Context.Service<WorkspaceCleanup, WorkspaceCleanupContract>()(
  'friday/workspaces/WorkspaceCleanup',
) {}

const isDirectChild = (workspace: string, candidate: string): boolean => {
  const path = relative(workspace, candidate)
  return path.length > 0 && !path.startsWith('..') && !isAbsolute(path) && !path.includes('/')
}

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
    status: proposal.status,
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
      const existing = yield* sql<Record<string, unknown>>`
        SELECT * FROM workspace_cleanup_proposals
        WHERE thread_id = ${thread.id} AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
      `
      const existingProposal = (yield* decodeProposalRows(existing))[0]
      if (existingProposal) {
        return yield* get(yield* decodeProposalId(existingProposal.proposal_id))
      }

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
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO workspace_cleanup_proposals (
              proposal_id, thread_id, status, workspace_path, estimated_bytes,
              created_at, applied_at, summary
            ) VALUES (
              ${proposalId}, ${thread.id}, 'pending', ${workspace}, ${estimatedBytes},
              ${createdAt}, NULL, ${summary}
            )
          `
          yield* Effect.forEach(
            resources,
            (resource) => sql`
              INSERT INTO workspace_cleanup_resources (
                proposal_id, worktree_path, branch, head, common_directory,
                status_porcelain, size_bytes
              ) VALUES (
                ${proposalId}, ${resource.path}, ${resource.branch}, ${resource.head},
                ${resource.commonDirectory}, ${resource.status}, ${resource.sizeBytes}
              )
            `,
            { discard: true },
          )
        }),
      )
      return yield* get(proposalId)
    })

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
      if (proposal.status !== 'pending') {
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
        return yield* new WorkspaceCleanupError({
          operation: 'validate',
          detail: 'The channel workspace changed after cleanup approval was requested.',
        })
      }
      yield* Effect.forEach(proposal.resources, removeRepositoryWorktree, {
        discard: true,
        concurrency: 1,
      }).pipe(
        Effect.tapError(() =>
          sql`
            UPDATE workspace_cleanup_proposals
            SET status = 'stale'
            WHERE proposal_id = ${proposalId}
          `.pipe(Effect.ignore),
        ),
      )
      const appliedAt = DateTime.formatIso(yield* DateTime.now)
      yield* sql`
        UPDATE workspace_cleanup_proposals
        SET status = 'applied', applied_at = ${appliedAt}
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
        apply(proposalId, currentWorkingDirectory).pipe(Effect.mapError(mapFailure('apply'))),
    })
  }),
)
