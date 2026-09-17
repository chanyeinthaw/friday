import type { ChannelThread, TaskId, ThreadId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Semaphore from 'effect/Semaphore'

import type { TerminalTurn } from '../conversation/ThreadCoordinator.ts'
import type { ThreadPersistenceError } from '../conversation/ThreadPersistence.ts'
import type { ThreadRuntimeError } from '../conversation/ThreadRuntimes.ts'
import type { MakeTasksOptions } from './TaskDependencies.ts'
import type { TaskError } from './TaskError.ts'

interface TaskLifecycle {
  readonly generation: number
  cancelled: boolean
}

interface TaskLifecycleRecord {
  readonly lock: Semaphore.Semaphore
  readonly active: Set<TaskLifecycle>
  nextGeneration: number
  users: number
}

interface WatchTaskCompletionInput {
  readonly parent: ChannelThread
  readonly taskId: TaskId
  readonly threadId: ThreadId
  readonly task: string | undefined
  readonly awaitTerminal: Effect.Effect<TerminalTurn, ThreadRuntimeError | ThreadPersistenceError>
  readonly failureMessage: string
}

const renderTaskOutcome = (terminal: TerminalTurn): string => {
  switch (terminal.status) {
    case 'completed':
      return `Background work for the earlier request completed.\n\nUse the following findings as your own working context. Do not mention the background task unless the user explicitly asks about Friday's internals:\n\n${terminal.agentMessage}`
    case 'interrupted':
      return `Background work for the earlier request was interrupted.${
        terminal.agentMessage
          ? `\n\nUse the following partial findings as your own working context. Do not mention the background task unless the user explicitly asks about Friday's internals:\n\n${terminal.agentMessage}`
          : ''
      }`
    case 'failed':
      return `Background work for the earlier request failed. Decide whether to retry, redirect, or explain the failure in your own voice. Do not mention the background task unless the user explicitly asks about Friday's internals.\n\nFailure details:\n${terminal.errorMessage}`
  }
  return terminal
}

export interface TaskCompletion {
  readonly watch: (input: WatchTaskCompletionInput) => Effect.Effect<void>
  readonly cancel: (
    parent: ChannelThread,
    taskId: TaskId,
    cancelTurn: Effect.Effect<void, TaskError | ThreadPersistenceError>,
  ) => Effect.Effect<void, TaskError | ThreadPersistenceError>
}

export const makeTaskCompletion = (options: MakeTasksOptions): TaskCompletion => {
  const taskLifecycles = new Map<TaskId, TaskLifecycleRecord>()

  const lifecycleRecordFor = (taskId: TaskId): TaskLifecycleRecord => {
    const existing = taskLifecycles.get(taskId)
    if (existing) return existing
    const created: TaskLifecycleRecord = {
      lock: Semaphore.makeUnsafe(1),
      active: new Set(),
      nextGeneration: 1,
      users: 0,
    }
    taskLifecycles.set(taskId, created)
    return created
  }

  const withTaskLifecycle = <A, E, R>(
    taskId: TaskId,
    operation: (record: TaskLifecycleRecord) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const record = lifecycleRecordFor(taskId)
      record.users += 1
      return record.lock.withPermit(Effect.uninterruptible(operation(record))).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            record.users -= 1
            if (
              record.users === 0 &&
              record.active.size === 0 &&
              taskLifecycles.get(taskId) === record
            ) {
              taskLifecycles.delete(taskId)
            }
          }),
        ),
      )
    })

  const publishTaskActivity = (
    operation: 'started' | 'finished',
    parent: ChannelThread,
    taskId: TaskId,
    task?: string,
  ): Effect.Effect<void> => {
    if (!options.conversationTitles) return Effect.void
    return (
      operation === 'started'
        ? options.conversationTitles.taskStarted(parent, taskId, task)
        : options.conversationTitles.taskFinished(parent, taskId)
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('Task title activity publication failed', cause).pipe(
          Effect.annotateLogs({ operation, taskId, parentThreadId: parent.id }),
        ),
      ),
    )
  }

  const taskStarted = (
    parent: ChannelThread,
    taskId: TaskId,
    task?: string,
  ): Effect.Effect<TaskLifecycle> =>
    withTaskLifecycle(taskId, (record) =>
      Effect.gen(function* () {
        const lifecycle: TaskLifecycle = {
          generation: record.nextGeneration,
          cancelled: false,
        }
        record.nextGeneration += 1
        const wasIdle = record.active.size === 0
        record.active.add(lifecycle)
        if (wasIdle) yield* publishTaskActivity('started', parent, taskId, task)
        return lifecycle
      }),
    )

  const taskFinished = (
    parent: ChannelThread,
    taskId: TaskId,
    lifecycle: TaskLifecycle,
  ): Effect.Effect<void> =>
    withTaskLifecycle(taskId, (record) =>
      Effect.gen(function* () {
        if (!record.active.delete(lifecycle)) return
        if (record.active.size === 0) yield* publishTaskActivity('finished', parent, taskId)
      }),
    )

  const watch = Effect.fn('Tasks.watchCompletion')(function* (input: WatchTaskCompletionInput) {
    const lifecycle = yield* taskStarted(input.parent, input.taskId, input.task)
    yield* options
      .fork(
        input.awaitTerminal.pipe(
          Effect.flatMap((terminal) =>
            Effect.gen(function* () {
              yield* options.persistence.closeThread({
                threadId: input.threadId,
                closedAt: yield* options.now,
              })
              if (lifecycle.cancelled) return
              yield* options.channelTurns.accept({
                thread: input.parent,
                message: {
                  source: 'agent',
                  content: { text: renderTaskOutcome(terminal), images: [] },
                },
              })
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logError(input.failureMessage, cause).pipe(
              Effect.annotateLogs({
                taskId: input.taskId,
                parentThreadId: input.parent.id,
              }),
            ),
          ),
          Effect.ensuring(taskFinished(input.parent, input.taskId, lifecycle)),
        ),
      )
      .pipe(Effect.onError(() => taskFinished(input.parent, input.taskId, lifecycle)))
  })

  const cancel = (
    parent: ChannelThread,
    taskId: TaskId,
    cancelTurn: Effect.Effect<void, TaskError | ThreadPersistenceError>,
  ): Effect.Effect<void, TaskError | ThreadPersistenceError> =>
    withTaskLifecycle(taskId, (record) =>
      Effect.gen(function* () {
        const lifecycle = Array.from(record.active).reduce<TaskLifecycle | null>(
          (latest, candidate) =>
            latest === null || candidate.generation > latest.generation ? candidate : latest,
          null,
        )
        if (lifecycle !== null) lifecycle.cancelled = true
        yield* cancelTurn.pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (lifecycle !== null) lifecycle.cancelled = false
            }),
          ),
        )
        if (lifecycle === null) yield* publishTaskActivity('finished', parent, taskId)
        else {
          record.active.delete(lifecycle)
          if (record.active.size === 0) yield* publishTaskActivity('finished', parent, taskId)
        }
      }),
    )

  return { watch, cancel }
}
