import { ThreadId } from '@friday/contracts/conversation'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { ChannelTurns } from '../conversation/ChannelTurns.ts'
import { ThreadPersistence } from '../conversation/ThreadPersistence.ts'
import {
  WorkspaceCleanup,
  WorkspaceCleanupError,
  type WorkspaceCleanupProposal,
} from './WorkspaceCleanup.ts'

export interface WorkspaceCleanupNotificationsContract {
  readonly runPass: Effect.Effect<void, WorkspaceCleanupError>
  readonly run: Effect.Effect<void>
}

export class WorkspaceCleanupNotifications extends Context.Service<
  WorkspaceCleanupNotifications,
  WorkspaceCleanupNotificationsContract
>()('friday/workspaces/WorkspaceCleanupNotifications') {}

const retentionDays = 30
const retentionMilliseconds = retentionDays * 24 * 60 * 60 * 1_000

const formatBytes = (bytes: number): string => {
  if (bytes < 1_024 * 1_024) return `${Math.ceil(bytes / 1_024)} KiB`
  if (bytes < 1_024 * 1_024 * 1_024) return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`
  return `${(bytes / (1_024 * 1_024 * 1_024)).toFixed(1)} GiB`
}

const decodeThreadId = Schema.decodeUnknownEffect(ThreadId)

const renderProposal = (proposal: WorkspaceCleanupProposal): string => {
  const resources = proposal.resources
    .map(({ path, status, branch }) => {
      const name = path.split('/').at(-1) ?? path
      const details = [
        status.length > 0 ? 'uncommitted files' : null,
        branch.startsWith('friday/task/') ? 'isolated task branch' : null,
      ]
        .filter((detail): detail is string => detail !== null)
        .join(', ')
      return `- \`${name}\`${details ? ` — ${details}` : ''}`
    })
    .join('\n')
  return `@here This thread has been inactive for ${retentionDays} days and its workspace is using approximately ${formatBytes(proposal.estimatedBytes)}.\n\nI found repository worktrees that may contain work worth keeping, so I will not remove them automatically:\n\n${resources}\n\nIf you want to permanently remove these worktrees, reply here with explicit approval. I will then apply cleanup proposal \`${proposal.id}\`. Conversation history and shared repository caches will be retained.`
}

export const WorkspaceCleanupNotificationsLive = Layer.effect(
  WorkspaceCleanupNotifications,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const persistence = yield* ThreadPersistence
    const cleanup = yield* WorkspaceCleanup
    const channelTurns = yield* ChannelTurns

    const runPass = Effect.fn('WorkspaceCleanupNotifications.runPass')(function* () {
      const now = yield* Clock.currentTimeMillis
      const threshold = new Date(now - retentionMilliseconds).toISOString()
      const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id
        FROM threads
        WHERE audience = 'user'
          AND status = 'active'
          AND updated_at <= ${threshold}
          AND NOT EXISTS (
            SELECT 1 FROM workspace_cleanup_proposals
            WHERE workspace_cleanup_proposals.thread_id = threads.thread_id
              AND workspace_cleanup_proposals.lifecycle_status IN ('pending', 'failed')
          )
        ORDER BY updated_at ASC
      `
      yield* Effect.forEach(
        rows,
        ({ thread_id: threadId }) =>
          decodeThreadId(threadId).pipe(
            Effect.flatMap((id) => persistence.getThread(id)),
            Effect.flatMap((thread) => {
              if (Option.isNone(thread) || thread.value.audience !== 'user') return Effect.void
              const channelThread = thread.value
              return cleanup.propose(channelThread).pipe(
                Effect.flatMap((proposal) => {
                  if (proposal === null) return Effect.void
                  return channelTurns.accept({
                    thread: channelThread,
                    message: {
                      source: 'system',
                      content: { text: renderProposal(proposal), images: [] },
                    },
                  })
                }),
              )
            }),
            Effect.tapError((cause) =>
              Effect.logWarning('workspace.cleanup.notification-failed').pipe(
                Effect.annotateLogs({ threadId, cause: String(cause) }),
              ),
            ),
            Effect.ignore,
          ),
        { discard: true, concurrency: 2 },
      )
    })

    const configuredPass = runPass().pipe(
      Effect.mapError((cause) =>
        cause instanceof WorkspaceCleanupError
          ? cause
          : new WorkspaceCleanupError({
              operation: 'inspect',
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
      ),
    )
    const supervisedPass = configuredPass.pipe(
      Effect.tapError((cause) =>
        Effect.logError('workspace.cleanup.pass-failed').pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
      Effect.ignore,
    )
    return WorkspaceCleanupNotifications.of({
      runPass: configuredPass,
      run: supervisedPass.pipe(
        Effect.delay('24 hours'),
        Effect.repeat(Schedule.spaced('24 hours')),
        Effect.asVoid,
      ),
    })
  }),
)
