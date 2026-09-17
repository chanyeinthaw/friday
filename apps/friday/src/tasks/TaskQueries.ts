import {
  TaskId,
  TaskInspectCursor,
  TaskInspectDefaultLimit,
  ThreadId,
  type InspectTaskRequest,
  type InspectTaskResult,
  type ListTasksRequest,
  type TaskSummary,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { MakeTasksOptions } from './TaskDependencies.ts'
import { taskError } from './TaskError.ts'
import {
  buildInspectSnapshotBoundary,
  buildOrderedTaskActivities,
  buildTaskOutline,
  decodeInspectCursor,
  encodeInspectCursor,
  inspectPositionForActivity,
  isOlderThanInspectCursor,
  isWithinInspectSnapshot,
} from './TaskInspection.ts'
import { requireChannelThread } from './TaskOperations.ts'
import { matchesTaskStatusFilter } from './TaskPolicy.ts'

const decodeTaskId = Schema.decodeUnknownEffect(TaskId)
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId)

export const makeTaskQueries = (options: MakeTasksOptions) => {
  const list = Effect.fn('Tasks.list')(function* (request: ListTasksRequest) {
    yield* requireChannelThread(options.persistence, request.parentThreadId)
    const threads = yield* options.persistence.listAgentThreads({
      parentThreadId: request.parentThreadId,
    })
    const summaries = yield* Effect.forEach(threads, (thread) =>
      Effect.gen(function* () {
        const first = yield* options.persistence.getFirstTurn(thread.id)
        const latest = yield* options.persistence.getLatestTurn(thread.id)
        if (Option.isNone(first) || Option.isNone(latest)) return null
        const base = {
          taskId: yield* decodeTaskId(thread.id).pipe(
            Effect.mapError(() =>
              taskError(
                'task-not-found',
                `Agent Thread '${thread.id}' is not a valid task.`,
                'list',
              ),
            ),
          ),
          role: thread.role,
          status: latest.value.status,
          task: first.value.input.content.text,
          workingDirectory: thread.workingDirectory,
          mayWrite: thread.mayWrite ?? true,
          model: thread.model,
          thinkingLevel: thread.thinkingLevel,
          createdAt: thread.createdAt,
          completedAt: latest.value.completedAt,
        }
        return (
          thread.subagentProfile === undefined ? base : { ...base, profile: thread.subagentProfile }
        ) satisfies TaskSummary
      }),
    )
    const present = summaries.filter((summary): summary is TaskSummary => summary !== null)
    const filter = request.status ?? 'all'
    return present.filter((summary) => matchesTaskStatusFilter(summary.status, filter))
  })

  const requireInspectTask = Effect.fn('Tasks.requireInspectTask')(function* (
    parentThreadId: InspectTaskRequest['parentThreadId'],
    taskId: InspectTaskRequest['taskId'],
  ) {
    const threadId = yield* decodeThreadId(taskId).pipe(
      Effect.mapError(() =>
        taskError('task-not-found', `Task '${taskId}' was not found.`, 'inspect'),
      ),
    )
    const found = yield* options.persistence.getThread(threadId)
    if (Option.isNone(found) || found.value.audience !== 'agent') {
      return yield* taskError('task-not-found', `Task '${taskId}' was not found.`, 'inspect')
    }
    if (found.value.parent.threadId !== parentThreadId) {
      return yield* taskError('task-not-found', `Task '${taskId}' was not found.`, 'inspect')
    }
    return found.value
  })

  const inspect = Effect.fn('Tasks.inspect')(function* (request: InspectTaskRequest) {
    const parent = yield* requireChannelThread(options.persistence, request.parentThreadId)
    const thread = yield* requireInspectTask(request.parentThreadId, request.taskId)
    const turns = yield* options.persistence.listTurns(thread.id)
    const first = turns.at(0)
    const latest = turns.at(-1)
    if (first === undefined || latest === undefined) {
      return yield* taskError(
        'task-not-active',
        `Task '${request.taskId}' has no Turns.`,
        'inspect',
      )
    }
    const limit = request.limit ?? TaskInspectDefaultLimit
    const cursor =
      request.cursor === undefined
        ? null
        : Option.getOrElse(decodeInspectCursor(request.cursor, request.taskId), () => null)
    if (request.cursor !== undefined && cursor === null) {
      return yield* taskError(
        'invalid-cursor',
        'The task inspection cursor is invalid or does not belong to this task.',
        'inspect',
      )
    }
    const runtime = yield* options.friday.observeRuntime(thread.id)
    const outline = buildTaskOutline({
      taskId: request.taskId,
      thread,
      parent,
      latestTurn: latest,
      runtime,
    })
    const ordered = buildOrderedTaskActivities(turns)
    const boundary = cursor?.boundary ?? buildInspectSnapshotBoundary(ordered)
    const filtered = ordered.filter((activity) => {
      const position = inspectPositionForActivity(activity, boundary)
      return (
        isWithinInspectSnapshot(position, boundary) &&
        (cursor === null || isOlderThanInspectCursor(position, cursor.after))
      )
    })
    const page = filtered.slice(0, limit)
    const hasMore = filtered.length > limit
    const last = page.at(-1)
    const nextCursor: TaskInspectCursor | null =
      hasMore && last !== undefined
        ? encodeInspectCursor(request.taskId, boundary, {
            ...inspectPositionForActivity(last, boundary),
          })
        : null
    return {
      outline,
      activities: page.map(({ summary }) => summary),
      nextCursor,
      hasMore,
    } satisfies InspectTaskResult
  })

  return { list, inspect }
}
