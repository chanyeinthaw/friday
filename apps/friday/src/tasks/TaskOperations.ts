/* oxlint-disable effecttsgo/node-builtin-import -- Working-directory validation uses Node path semantics. */

import {
  ThreadId,
  WorkingDirectory,
  type ChannelThread,
  type StartTaskRequest,
  type TaskId,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { isAbsolute } from 'node:path'

import type { ThreadPersistenceContract } from '../conversation/ThreadPersistence.ts'
import { isWorkingDirectoryInsideWorkspace } from './TaskPolicy.ts'
import { taskError, type TaskError } from './TaskError.ts'
import type { TaskModelsContract } from './TaskModels.ts'

const decodeThreadId = Schema.decodeUnknownEffect(ThreadId)
const decodeWorkingDirectory = Schema.decodeUnknownEffect(WorkingDirectory)

export const resolveTaskProfile = Effect.fn('Tasks.resolveProfile')(function* (
  models: TaskModelsContract,
  requested: StartTaskRequest['profile'],
  operation: TaskError['operation'],
) {
  const resolved =
    requested === undefined ? yield* models.defaultProfile : yield* models.resolve(requested)
  if (Option.isNone(resolved)) {
    return yield* taskError(
      'model-not-configured',
      requested === undefined
        ? "No 'primary' subagent profile is configured."
        : `Subagent profile '${requested}' is not configured.`,
      operation,
    )
  }
  return resolved.value
})

export const requireChannelThread = Effect.fn('Tasks.requireChannelThread')(function* (
  persistence: ThreadPersistenceContract,
  parentThreadId: StartTaskRequest['parentThreadId'],
) {
  const found = yield* persistence.getThread(parentThreadId)
  if (Option.isNone(found)) {
    return yield* taskError('parent-not-found', `Parent Thread '${parentThreadId}' was not found.`)
  }
  if (found.value.audience !== 'user') {
    return yield* taskError(
      'parent-not-channel',
      `Thread '${parentThreadId}' is not a channel Thread.`,
    )
  }
  return found.value
})

export const requireOwnedTask = Effect.fn('Tasks.requireOwnedTask')(function* (
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
  if (Option.isNone(found) || found.value.audience !== 'agent') {
    return yield* taskError('task-not-found', `Task '${taskId}' was not found.`, operation)
  }
  if (found.value.parent.threadId !== parentThreadId) {
    return yield* taskError(
      'task-not-owned',
      `Task '${taskId}' does not belong to this channel.`,
      operation,
    )
  }
  return found.value
})

export const validateWorkingDirectory = Effect.fn('Tasks.validateWorkingDirectory')(function* (
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
