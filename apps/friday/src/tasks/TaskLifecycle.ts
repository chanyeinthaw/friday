import {
  AgentThread,
  TaskId,
  ThreadId,
  Turn,
  TurnId,
  WorkingDirectory,
  type BootstrapTaskRequest,
  type ChannelThread,
  type StartTaskRequest,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import { createIsolatedWorktree, isManagedWorktree } from '../repositories/RepositoryWorktrees.ts'
import { quoteShellArgument } from './ShellQuote.ts'
import type { TaskCompletion } from './TaskCompletion.ts'
import type { MakeTasksOptions } from './TaskDependencies.ts'
import { taskError } from './TaskError.ts'
import {
  requireChannelThread,
  resolveTaskProfile,
  validateWorkingDirectory,
} from './TaskOperations.ts'
import { isActiveTaskStatus, workingDirectoriesConflict } from './TaskPolicy.ts'

const decodeAgentThread = Schema.decodeUnknownEffect(AgentThread)
const decodeTaskId = Schema.decodeUnknownEffect(TaskId)
const decodeThreadId = Schema.decodeUnknownEffect(ThreadId)
const decodeTurn = Schema.decodeUnknownEffect(Turn)
const decodeTurnId = Schema.decodeUnknownEffect(TurnId)
const decodeWorkingDirectory = Schema.decodeUnknownEffect(WorkingDirectory)

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

export const makeTaskLifecycle = (options: MakeTasksOptions, completion: TaskCompletion) => {
  const launchLock = Semaphore.makeUnsafe(1)

  const launchTaskUnlocked = Effect.fn('Tasks.launchTask')(function* (input: LaunchTaskInput) {
    let effectiveWorkingDirectory = input.workingDirectory
    let primaryWorkingDirectory = input.primaryWorkingDirectory
    const managedWorktree = options.isManagedWorktree ?? isManagedWorktree
    const isolateWorktree = options.createIsolatedWorktree ?? createIsolatedWorktree
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
        const isManaged = yield* managedWorktree(input.workingDirectory).pipe(
          Effect.mapError((cause) =>
            taskError(
              'start-failed',
              `Could not inspect managed worktree ownership for '${input.workingDirectory}': ${cause.message}`,
              input.operation,
            ),
          ),
        )
        if (!isManaged) {
          return yield* taskError(
            'working-directory-busy',
            `Task '${existing.id}' has active ${existingMayWrite ? 'write' : 'read'} access to '${input.workingDirectory}'. This directory is not a Friday-managed repository worktree, so concurrent work cannot be isolated. Wait for or cancel the existing task, or choose a non-overlapping working directory.`,
            input.operation,
          )
        }
        const isolated = yield* isolateWorktree({
          primaryWorktree: input.workingDirectory,
          taskId: `task-${yield* options.randomUUID}`,
        }).pipe(
          Effect.mapError((cause) =>
            taskError(
              'working-directory-busy',
              `Could not isolate concurrent work from managed worktree '${input.workingDirectory}': ${cause.message}`,
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
    const profile = yield* resolveTaskProfile(options.models, input.profile, input.operation)
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
      model: profile.model,
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
      model: profile.model,
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
    yield* completion.watch({
      parent: input.parent,
      taskId,
      threadId: thread.id,
      task: input.task,
      awaitTerminal: handle.awaitTerminal,
      failureMessage: 'Task completion delivery failed',
    })
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
    const { path: resolvedWorkingDirectory, info } = yield* Effect.gen(function* () {
      const path = yield* options.fileSystem.realPath(parent.workingDirectory)
      const directoryInfo = yield* options.fileSystem.stat(path)
      return { path, info: directoryInfo }
    }).pipe(
      Effect.mapError(() =>
        taskError(
          'invalid-working-directory',
          `Channel workspace '${parent.workingDirectory}' cannot be used for bootstrap work.`,
          'bootstrap',
        ),
      ),
    )
    if (info.type !== 'Directory') {
      return yield* taskError(
        'invalid-working-directory',
        `Channel workspace '${parent.workingDirectory}' is not a directory.`,
        'bootstrap',
      )
    }
    const workingDirectory = yield* decodeWorkingDirectory(resolvedWorkingDirectory).pipe(
      Effect.mapError((cause) =>
        taskError(
          'invalid-working-directory',
          `Channel workspace '${resolvedWorkingDirectory}' is invalid: ${String(cause)}`,
          'bootstrap',
        ),
      ),
    )
    // The channel agent owns the durable branch name. Carry it in the
    // bootstrap instruction so the bootstrap agent passes it to
    // `friday worktree ensure --branch <name>`. Omit it unchanged when the
    // channel agent did not choose one (read-only work or low context).
    // Quote as one POSIX shell word so metacharacters cannot split or expand.
    const quotedBranch =
      request.branch === undefined ? undefined : quoteShellArgument(request.branch)
    const task =
      request.branch === undefined || quotedBranch === undefined
        ? request.task
        : `${request.task}\n\nUse durable branch ${quotedBranch} for the managed worktree: pass --branch ${quotedBranch} to \`friday worktree ensure\`.`
    return yield* launchTask({
      parent,
      parentTurnId: request.parentTurnId,
      task,
      workingDirectory,
      mayWrite: true,
      profile: request.profile,
      role: 'bootstrap',
      operation: 'bootstrap',
    })
  })

  return { start, bootstrap }
}
