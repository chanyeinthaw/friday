/* oxlint-disable effecttsgo/node-builtin-import -- Working-directory validation uses Node path semantics. */

import {
  ActivityId,
  AgentThread,
  SteeringActivity,
  TaskId,
  ThreadId,
  Turn,
  TurnId,
  WorkingDirectory,
  type BootstrapTaskRequest,
  type CancelTaskRequest,
  type ChannelThread,
  type IsoDateTime,
  type ListTasksRequest,
  type StartedTask,
  type StartTaskRequest,
  type SteerTaskRequest,
  type TaskSummary,
} from '@friday/contracts/conversation'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { isAbsolute } from 'node:path'

import { Friday, type FridayContract } from '../Friday.ts'
import {
  ConversationTitles,
  type ConversationTitlesContract,
} from '../platforms/ConversationTitles.ts'
import { ChannelTurns, type ChannelTurnsContract } from '../conversation/ChannelTurns.ts'
import type { TerminalTurn, ThreadCoordinatorContract } from '../conversation/ThreadCoordinator.ts'
import {
  ThreadPersistence,
  type ThreadPersistenceContract,
  type ThreadPersistenceError,
} from '../conversation/ThreadPersistence.ts'
import type { ThreadRuntimeError } from '../conversation/ThreadRuntimes.ts'
import { createIsolatedWorktree } from '../repositories/RepositoryWorktrees.ts'
import { TaskModels, type TaskModelsContract } from './TaskModels.ts'
import {
  isActiveTaskStatus,
  isWorkingDirectoryInsideWorkspace,
  matchesTaskStatusFilter,
  workingDirectoriesConflict,
} from './TaskPolicy.ts'

export class TaskError extends Schema.Error<TaskError>('TaskError')({
  _tag: Schema.tag('TaskError'),
  operation: Schema.Literals(['start', 'bootstrap', 'steer', 'list', 'cancel']),
  reason: Schema.Literals([
    'model-not-configured',
    'invalid-working-directory',
    'channel-workspace',
    'outside-channel-workspace',
    'working-directory-busy',
    'task-not-found',
    'task-not-owned',
    'task-not-active',
    'parent-not-found',
    'parent-not-channel',
    'start-failed',
  ]),
  detail: Schema.String,
}) {}

export interface TasksContract {
  readonly start: (
    request: StartTaskRequest,
  ) => Effect.Effect<StartedTask, TaskError | ThreadPersistenceError>
  readonly bootstrap: (
    request: BootstrapTaskRequest,
  ) => Effect.Effect<StartedTask, TaskError | ThreadPersistenceError>
  readonly steer: (
    request: SteerTaskRequest,
  ) => Effect.Effect<void, TaskError | ThreadPersistenceError>
  readonly list: (
    request: ListTasksRequest,
  ) => Effect.Effect<ReadonlyArray<TaskSummary>, TaskError | ThreadPersistenceError>
  readonly cancel: (
    request: CancelTaskRequest,
  ) => Effect.Effect<void, TaskError | ThreadPersistenceError>
}

export class Tasks extends Context.Service<Tasks, TasksContract>()('friday/tasks/Tasks') {}

export interface MakeTasksOptions {
  readonly persistence: ThreadPersistenceContract
  readonly friday: FridayContract
  readonly models: TaskModelsContract
  readonly channelTurns: ChannelTurnsContract
  readonly conversationTitles?: ConversationTitlesContract
  readonly fileSystem: FileSystem.FileSystem
  readonly randomUUID: Effect.Effect<string, TaskError>
  readonly now: Effect.Effect<IsoDateTime>
  readonly fork: (effect: Effect.Effect<void>) => Effect.Effect<void>
}

const decodeActivityId = Schema.decodeUnknownEffect(ActivityId)
const decodeAgentThread = Schema.decodeUnknownEffect(AgentThread)
const decodeSteeringActivity = Schema.decodeUnknownEffect(SteeringActivity)
const decodeTaskId = Schema.decodeUnknownEffect(TaskId)
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId)
const decodeTurn = Schema.decodeUnknownEffect(Turn)
const decodeTurnId = Schema.decodeUnknownEffect(TurnId)
const decodeWorkingDirectory = Schema.decodeUnknownEffect(WorkingDirectory)

const renderTaskOutcome = (_taskId: TaskId, terminal: TerminalTurn): string => {
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
}

const taskError = (
  reason: TaskError['reason'],
  detail: string,
  operation: TaskError['operation'] = 'start',
) => new TaskError({ operation, reason, detail })

const resolveProfile = Effect.fn('Tasks.resolveProfile')(function* (
  models: TaskModelsContract,
  requested: StartTaskRequest['profile'],
  operation: TaskError['operation'],
) {
  const resolved =
    requested === undefined ? yield* models.defaultProfile : yield* models.resolve(requested)
  return yield* Option.match(resolved, {
    onNone: () =>
      Effect.fail(
        taskError(
          'model-not-configured',
          requested === undefined
            ? "No 'primary' subagent profile is configured."
            : `Subagent profile '${requested}' is not configured.`,
          operation,
        ),
      ),
    onSome: Effect.succeed,
  })
})

const requireChannelThread = Effect.fn('Tasks.requireChannelThread')(function* (
  persistence: ThreadPersistenceContract,
  parentThreadId: StartTaskRequest['parentThreadId'],
) {
  const found = yield* persistence.getThread(parentThreadId)
  return yield* Option.match(found, {
    onNone: () =>
      Effect.fail(
        taskError('parent-not-found', `Parent Thread '${parentThreadId}' was not found.`),
      ),
    onSome: (thread) =>
      thread.audience === 'user'
        ? Effect.succeed(thread)
        : Effect.fail(
            taskError('parent-not-channel', `Thread '${parentThreadId}' is not a channel Thread.`),
          ),
  })
})

const requireOwnedTask = Effect.fn('Tasks.requireOwnedTask')(function* (
  persistence: ThreadPersistenceContract,
  operation: TaskError['operation'],
  parentThreadId: ThreadId,
  taskId: TaskId,
) {
  const threadId = yield* decodeThreadId(taskId).pipe(
    Effect.mapError(() =>
      taskError('task-not-found', `Task '${taskId}' was not found.`, operation),
    ),
  )
  const found = yield* persistence.getThread(threadId)
  return yield* Option.match(found, {
    onNone: () =>
      Effect.fail(taskError('task-not-found', `Task '${taskId}' was not found.`, operation)),
    onSome: (thread) => {
      if (thread.audience !== 'agent') {
        return Effect.fail(
          taskError('task-not-found', `Task '${taskId}' was not found.`, operation),
        )
      }
      if (thread.parent.threadId !== parentThreadId) {
        return Effect.fail(
          taskError(
            'task-not-owned',
            `Task '${taskId}' does not belong to this channel.`,
            operation,
          ),
        )
      }
      return Effect.succeed(thread)
    },
  })
})

const validateWorkingDirectory = Effect.fn('Tasks.validateWorkingDirectory')(function* (
  fileSystem: FileSystem.FileSystem,
  parent: ChannelThread,
  workingDirectory: StartTaskRequest['workingDirectory'],
) {
  if (!isAbsolute(workingDirectory)) {
    return yield* taskError(
      'invalid-working-directory',
      `Task working directory '${workingDirectory}' must be absolute.`,
    )
  }
  const directory = yield* fileSystem.realPath(workingDirectory).pipe(
    Effect.flatMap((path) => fileSystem.stat(path).pipe(Effect.as(path))),
    Effect.mapError(() =>
      taskError(
        'invalid-working-directory',
        `Task working directory '${workingDirectory}' does not exist.`,
      ),
    ),
  )
  const info = yield* fileSystem
    .stat(directory)
    .pipe(
      Effect.mapError(() =>
        taskError(
          'invalid-working-directory',
          `Task working directory '${workingDirectory}' cannot be inspected.`,
        ),
      ),
    )
  if (info.type !== 'Directory') {
    return yield* taskError(
      'invalid-working-directory',
      `Task working directory '${workingDirectory}' is not a directory.`,
    )
  }
  const channelWorkspace = yield* fileSystem
    .realPath(parent.workingDirectory)
    .pipe(
      Effect.mapError(() =>
        taskError('invalid-working-directory', 'The parent channel workspace cannot be resolved.'),
      ),
    )
  if (!isWorkingDirectoryInsideWorkspace(channelWorkspace, directory)) {
    return yield* taskError(
      'outside-channel-workspace',
      `Normal tasks must run inside the parent channel workspace '${channelWorkspace}'.`,
    )
  }
  return yield* decodeWorkingDirectory(directory).pipe(
    Effect.mapError((cause) =>
      taskError(
        'invalid-working-directory',
        `Task working directory '${directory}' is invalid: ${String(cause)}`,
      ),
    ),
  )
})

interface LaunchTaskInput {
  readonly parent: ChannelThread
  readonly parentTurnId: TurnId
  readonly task: string
  readonly workingDirectory: StartTaskRequest['workingDirectory']
  readonly primaryWorkingDirectory?: StartTaskRequest['workingDirectory']
  readonly mayWrite: boolean
  readonly profile: StartTaskRequest['profile']
  readonly role: AgentThread['role']
  readonly operation: 'start' | 'bootstrap'
}

export const makeTasks = (options: MakeTasksOptions): TasksContract => {
  const launchLock = Semaphore.makeUnsafe(1)
  const explicitlyCancelled = new Set<TaskId>()

  const launchTaskUnlocked = Effect.fn('Tasks.launchTask')(function* (input: LaunchTaskInput) {
    let effectiveWorkingDirectory = input.workingDirectory
    let primaryWorkingDirectory = input.primaryWorkingDirectory
    const existingTasks = yield* options.persistence.listAgentThreads({
      parentThreadId: input.parent.id,
    })
    for (const existing of existingTasks) {
      if (existing.id === input.parent.id) continue
      if (!workingDirectoriesConflict(existing.workingDirectory, input.workingDirectory)) continue
      const latest = yield* options.persistence.getLatestTurn(existing.id)
      if (Option.isSome(latest) && isActiveTaskStatus(latest.value.status)) {
        const existingMayWrite = existing.mayWrite ?? true
        if (!input.mayWrite && !existingMayWrite) continue
        const isolated = yield* createIsolatedWorktree({
          primaryWorktree: input.workingDirectory,
          taskId: `task-${yield* options.randomUUID}`,
        }).pipe(
          Effect.mapError((cause) =>
            taskError(
              'working-directory-busy',
              `Could not isolate concurrent work from '${input.workingDirectory}': ${cause.message}`,
              input.operation,
            ),
          ),
        )
        effectiveWorkingDirectory = yield* decodeWorkingDirectory(isolated.path).pipe(
          Effect.mapError((cause) =>
            taskError('invalid-working-directory', String(cause), input.operation),
          ),
        )
        primaryWorkingDirectory = input.workingDirectory
        break
      }
    }
    const profile = yield* resolveProfile(options.models, input.profile, input.operation)
    const model = profile.model
    const timestamp = yield* options.now
    const taskUuid = yield* options.randomUUID
    const turnUuid = yield* options.randomUUID
    const taskId = yield* decodeTaskId(`task-${taskUuid}`).pipe(
      Effect.mapError((cause) =>
        taskError(
          'start-failed',
          `Failed to construct the task identifier: ${String(cause)}`,
          input.operation,
        ),
      ),
    )
    const threadId = yield* decodeThreadId(taskId).pipe(
      Effect.mapError((cause) =>
        taskError(
          'start-failed',
          `Failed to construct the agent Thread identifier: ${String(cause)}`,
          input.operation,
        ),
      ),
    )
    const turnId = yield* decodeTurnId(`turn-${turnUuid}`).pipe(
      Effect.mapError((cause) =>
        taskError(
          'start-failed',
          `Failed to construct the Turn identifier: ${String(cause)}`,
          input.operation,
        ),
      ),
    )
    const threadInput = {
      id: threadId,
      audience: 'agent' as const,
      parent: { threadId: input.parent.id, turnId: input.parentTurnId },
      role: input.role,
      subagentProfile: profile.name,
      harness: input.parent.harness,
      harnessSession: null,
      workingDirectory: effectiveWorkingDirectory,
      mayWrite: input.mayWrite,
      model,
      thinkingLevel: profile.thinkingLevel,
      conversationBinding: null,
      status: 'active' as const,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
    }
    const thread = yield* decodeAgentThread(
      primaryWorkingDirectory === undefined
        ? threadInput
        : { ...threadInput, primaryWorkingDirectory },
    ).pipe(
      Effect.mapError((cause) =>
        taskError(
          'start-failed',
          `Failed to construct the agent Thread: ${String(cause)}`,
          input.operation,
        ),
      ),
    )
    const turn = yield* decodeTurn({
      id: turnId,
      threadId,
      sequence: 1,
      input: { source: 'agent', content: { text: input.task, images: [] } },
      agentMessage: null,
      activities: [],
      model,
      thinkingLevel: thread.thinkingLevel,
      harnessTurnId: null,
      status: 'pending',
      requestedAt: timestamp,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      usage: null,
    }).pipe(
      Effect.mapError((cause) =>
        taskError(
          'start-failed',
          `Failed to construct the initial task Turn: ${String(cause)}`,
          input.operation,
        ),
      ),
    )

    yield* options.persistence.createThread(thread)
    const coordinator = yield* options.friday
      .openThread(thread)
      .pipe(
        Effect.mapError((cause) =>
          taskError(
            'start-failed',
            `Failed to open task '${taskId}': ${String(cause)}`,
            input.operation,
          ),
        ),
      )
    const handle = yield* coordinator
      .prompt(turn)
      .pipe(
        Effect.mapError((cause) =>
          taskError(
            'start-failed',
            `Failed to start task '${taskId}': ${String(cause)}`,
            input.operation,
          ),
        ),
      )
    yield* options.fork(
      handle.awaitTerminal.pipe(
        Effect.flatMap((terminal) =>
          Effect.gen(function* () {
            if (options.conversationTitles) {
              yield* options.conversationTitles.taskFinished(input.parent, taskId)
            }
            yield* options.persistence.closeThread({
              threadId: thread.id,
              closedAt: yield* options.now,
            })
            if (explicitlyCancelled.delete(taskId)) return
            yield* options.channelTurns.accept({
              thread: input.parent,
              message: {
                source: 'agent',
                content: { text: renderTaskOutcome(taskId, terminal), images: [] },
              },
            })
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError('Task completion delivery failed', cause).pipe(
            Effect.annotateLogs({ taskId, parentThreadId: input.parent.id }),
          ),
        ),
      ),
    )

    if (options.conversationTitles) {
      yield* options.conversationTitles.taskStarted(input.parent, taskId)
    }
    return { taskId, status: 'pending' as const }
  })
  const launchTask = (input: LaunchTaskInput) => launchLock.withPermit(launchTaskUnlocked(input))

  const start = Effect.fn('Tasks.start')(function* (request: StartTaskRequest) {
    const parent = yield* requireChannelThread(options.persistence, request.parentThreadId)
    const workingDirectory = yield* validateWorkingDirectory(
      options.fileSystem,
      parent,
      request.workingDirectory,
    )
    return yield* launchTask({
      parent,
      parentTurnId: request.parentTurnId,
      task: request.task,
      workingDirectory,
      mayWrite: request.mayWrite ?? true,
      profile: request.profile,
      role: 'subagent',
      operation: 'start',
    })
  })

  const bootstrap = Effect.fn('Tasks.bootstrap')(function* (request: BootstrapTaskRequest) {
    const parent = yield* requireChannelThread(options.persistence, request.parentThreadId)
    const resolvedWorkingDirectory = yield* options.fileSystem
      .realPath(parent.workingDirectory)
      .pipe(
        Effect.flatMap((path) =>
          options.fileSystem
            .stat(path)
            .pipe(
              Effect.flatMap((info) =>
                info.type === 'Directory'
                  ? Effect.succeed(path)
                  : Effect.fail(
                      taskError(
                        'invalid-working-directory',
                        `Channel workspace '${parent.workingDirectory}' is not a directory.`,
                        'bootstrap',
                      ),
                    ),
              ),
            ),
        ),
        Effect.mapError((cause) =>
          cause instanceof TaskError
            ? cause
            : taskError(
                'invalid-working-directory',
                `Channel workspace '${parent.workingDirectory}' cannot be used for bootstrap work.`,
                'bootstrap',
              ),
        ),
      )
    const workingDirectory = yield* decodeWorkingDirectory(resolvedWorkingDirectory).pipe(
      Effect.mapError((cause) =>
        taskError(
          'invalid-working-directory',
          `Channel workspace '${resolvedWorkingDirectory}' is invalid: ${String(cause)}`,
          'bootstrap',
        ),
      ),
    )
    return yield* launchTask({
      parent,
      parentTurnId: request.parentTurnId,
      task: request.task,
      workingDirectory,
      mayWrite: true,
      profile: request.profile,
      role: 'bootstrap',
      operation: 'bootstrap',
    })
  })

  const makeContinuationTurn = Effect.fn('Tasks.makeContinuationTurn')(function* (
    thread: AgentThread,
    request: SteerTaskRequest,
    latest: Turn,
  ) {
    const timestamp = yield* options.now
    const turnUuid = yield* options.randomUUID
    const turnId = yield* decodeTurnId(`turn-${turnUuid}`).pipe(
      Effect.mapError((cause) =>
        taskError(
          'start-failed',
          `Failed to construct the continuation Turn: ${String(cause)}`,
          'steer',
        ),
      ),
    )
    return yield* decodeTurn({
      id: turnId,
      threadId: thread.id,
      sequence: latest.sequence + 1,
      input: { source: 'agent', content: { text: request.message, images: [] } },
      agentMessage: null,
      activities: [],
      model: thread.model,
      thinkingLevel: thread.thinkingLevel,
      harnessTurnId: null,
      status: 'pending',
      requestedAt: timestamp,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      usage: null,
    }).pipe(
      Effect.mapError((cause) =>
        taskError(
          'start-failed',
          `Failed to construct the continuation Turn: ${String(cause)}`,
          'steer',
        ),
      ),
    )
  })

  const steer = Effect.fn('Tasks.steer')(function* (request: SteerTaskRequest) {
    const thread = yield* requireOwnedTask(
      options.persistence,
      'steer',
      request.parentThreadId,
      request.taskId,
    )
    const latest = yield* options.persistence.getLatestTurn(thread.id)
    const turn = yield* Option.match(latest, {
      onNone: () =>
        Effect.fail(
          taskError('task-not-active', `Task '${request.taskId}' has no Turns.`, 'steer'),
        ),
      onSome: Effect.succeed,
    })
    const coordinator = yield* options.friday
      .openThread(thread)
      .pipe(
        Effect.mapError((cause) =>
          taskError(
            'start-failed',
            `Failed to open task '${request.taskId}': ${String(cause)}`,
            'steer',
          ),
        ),
      )
    if (isActiveTaskStatus(turn.status)) {
      const timestamp = yield* options.now
      const activityUuid = yield* options.randomUUID
      const activityId = yield* decodeActivityId(`activity-${activityUuid}`).pipe(
        Effect.mapError((cause) =>
          taskError(
            'start-failed',
            `Failed to construct steering Activity: ${String(cause)}`,
            'steer',
          ),
        ),
      )
      const activity = yield* decodeSteeringActivity({
        id: activityId,
        sequence: turn.activities.length,
        status: 'completed',
        type: 'steering',
        message: { source: 'agent', content: { text: request.message, images: [] } },
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
      }).pipe(
        Effect.mapError((cause) =>
          taskError(
            'start-failed',
            `Failed to construct steering Activity: ${String(cause)}`,
            'steer',
          ),
        ),
      )
      return yield* coordinator
        .steer(turn.id, activity)
        .pipe(
          Effect.mapError((cause) =>
            taskError(
              'start-failed',
              `Failed to steer task '${request.taskId}': ${String(cause)}`,
              'steer',
            ),
          ),
        )
    }
    const continuation = yield* makeContinuationTurn(thread, request, turn)
    const handle = yield* coordinator
      .prompt(continuation)
      .pipe(
        Effect.mapError((cause) =>
          taskError(
            'start-failed',
            `Failed to continue task '${request.taskId}': ${String(cause)}`,
            'steer',
          ),
        ),
      )
    const parent = yield* requireChannelThread(options.persistence, request.parentThreadId)
    yield* options.fork(
      handle.awaitTerminal.pipe(
        Effect.flatMap((terminal) =>
          Effect.gen(function* () {
            yield* options.persistence.closeThread({
              threadId: thread.id,
              closedAt: yield* options.now,
            })
            yield* options.channelTurns.accept({
              thread: parent,
              message: {
                source: 'agent',
                content: { text: renderTaskOutcome(request.taskId, terminal), images: [] },
              },
            })
          }),
        ),
        Effect.catchCause((cause) => Effect.logError('Task continuation delivery failed', cause)),
      ),
    )
  })

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

  const cancel = Effect.fn('Tasks.cancel')(function* (request: CancelTaskRequest) {
    const thread = yield* requireOwnedTask(
      options.persistence,
      'cancel',
      request.parentThreadId,
      request.taskId,
    )
    const latest = yield* options.persistence.getLatestTurn(thread.id)
    const turn = yield* Option.match(latest, {
      onNone: () =>
        Effect.fail(
          taskError('task-not-active', `Task '${request.taskId}' has no Turns.`, 'cancel'),
        ),
      onSome: Effect.succeed,
    })
    if (!isActiveTaskStatus(turn.status)) {
      return yield* taskError(
        'task-not-active',
        `Task '${request.taskId}' is already ${turn.status}.`,
        'cancel',
      )
    }
    const coordinator = yield* options.friday
      .openThread(thread)
      .pipe(
        Effect.mapError((cause) =>
          taskError(
            'start-failed',
            `Failed to open task '${request.taskId}': ${String(cause)}`,
            'cancel',
          ),
        ),
      )
    explicitlyCancelled.add(request.taskId)
    yield* coordinator.cancel(turn.id).pipe(
      Effect.tapError(() => Effect.sync(() => explicitlyCancelled.delete(request.taskId))),
      Effect.mapError((cause) =>
        taskError(
          'start-failed',
          `Failed to cancel task '${request.taskId}': ${String(cause)}`,
          'cancel',
        ),
      ),
    )
    const parent = yield* requireChannelThread(options.persistence, request.parentThreadId)
    if (options.conversationTitles) {
      yield* options.conversationTitles.taskFinished(parent, request.taskId)
    }
  })

  return Tasks.of({
    start,
    bootstrap,
    steer,
    list,
    cancel,
  })
}

export const TasksLive = Layer.effect(
  Tasks,
  Effect.gen(function* () {
    const persistence = yield* ThreadPersistence
    const friday = yield* Friday
    const models = yield* TaskModels
    const channelTurns = yield* ChannelTurns
    const conversationTitles = yield* ConversationTitles
    const fileSystem = yield* FileSystem.FileSystem
    const crypto = yield* Crypto.Crypto

    return makeTasks({
      persistence,
      friday,
      models,
      channelTurns,
      conversationTitles,
      fileSystem,
      randomUUID: crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          taskError('start-failed', `Failed to generate an identifier: ${String(cause)}`),
        ),
      ),
      now: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      fork: (effect) => effect.pipe(Effect.forkDetach, Effect.asVoid),
    })
  }),
)

export type TaskCoordinator = ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>
