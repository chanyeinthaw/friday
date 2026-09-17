import type {
  BootstrapTaskRequest,
  CancelTaskRequest,
  InspectTaskRequest,
  InspectTaskResult,
  ListTasksRequest,
  SetTaskModelRequest,
  SetTaskModelResult,
  StartedTask,
  StartTaskRequest,
  SteerTaskRequest,
  TaskSummary,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'

import { Friday } from '../Friday.ts'
import { ChannelTurns } from '../conversation/ChannelTurns.ts'
import type { ThreadCoordinatorContract } from '../conversation/ThreadCoordinator.ts'
import {
  ThreadPersistence,
  type ThreadPersistenceError,
} from '../conversation/ThreadPersistence.ts'
import type { ThreadRuntimeError } from '../conversation/ThreadRuntimes.ts'
import { ConversationTitles } from '../platforms/ConversationTitles.ts'
import { makeTaskCompletion } from './TaskCompletion.ts'
import { makeTaskControl } from './TaskControl.ts'
import type { MakeTasksOptions } from './TaskDependencies.ts'
import { TaskError, taskError } from './TaskError.ts'
import { makeTaskLifecycle } from './TaskLifecycle.ts'
import { TaskModels } from './TaskModels.ts'
import { makeTaskQueries } from './TaskQueries.ts'

export { TaskError }
export type { MakeTasksOptions }

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
  readonly inspect: (
    request: InspectTaskRequest,
  ) => Effect.Effect<InspectTaskResult, TaskError | ThreadPersistenceError>
  readonly setModel: (
    request: SetTaskModelRequest,
  ) => Effect.Effect<SetTaskModelResult, TaskError | ThreadPersistenceError>
}

export class Tasks extends Context.Service<Tasks, TasksContract>()('friday/tasks/Tasks') {}

export const makeTasks = (options: MakeTasksOptions): TasksContract => {
  const completion = makeTaskCompletion(options)
  const lifecycle = makeTaskLifecycle(options, completion)
  const control = makeTaskControl(options, completion)
  const queries = makeTaskQueries(options)

  return Tasks.of({
    ...lifecycle,
    ...control,
    ...queries,
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
