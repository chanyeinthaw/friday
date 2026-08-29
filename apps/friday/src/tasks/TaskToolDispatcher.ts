import type {
  BootstrapTaskRequest,
  CancelTaskRequest,
  ListTasksRequest,
  StartedTask,
  StartTaskRequest,
  SteerTaskRequest,
  TaskSummary,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import type { TaskError, TasksContract } from './Tasks.ts'
import type { ThreadPersistenceError } from '../conversation/ThreadPersistence.ts'

export class TaskToolUnavailableError extends Schema.Error<TaskToolUnavailableError>(
  'TaskToolUnavailableError',
)({
  _tag: Schema.tag('TaskToolUnavailableError'),
}) {}

export type TaskToolDispatchError = TaskError | ThreadPersistenceError | TaskToolUnavailableError

export interface TaskToolDispatcherContract {
  readonly start: (request: StartTaskRequest) => Effect.Effect<StartedTask, TaskToolDispatchError>
  readonly bootstrap: (
    request: BootstrapTaskRequest,
  ) => Effect.Effect<StartedTask, TaskToolDispatchError>
  readonly steer: (request: SteerTaskRequest) => Effect.Effect<void, TaskToolDispatchError>
  readonly list: (
    request: ListTasksRequest,
  ) => Effect.Effect<ReadonlyArray<TaskSummary>, TaskToolDispatchError>
  readonly cancel: (request: CancelTaskRequest) => Effect.Effect<void, TaskToolDispatchError>
  readonly bind: (tasks: TasksContract) => Effect.Effect<void>
}

export class TaskToolDispatcher extends Context.Service<
  TaskToolDispatcher,
  TaskToolDispatcherContract
>()('friday/tasks/TaskToolDispatcher') {}

export const TaskToolDispatcherLive = Layer.sync(TaskToolDispatcher, () => {
  let tasks: TasksContract | undefined
  const dispatch = <A, E>(operation: (tasks: TasksContract) => Effect.Effect<A, E>) =>
    tasks === undefined ? Effect.fail(new TaskToolUnavailableError()) : operation(tasks)

  return TaskToolDispatcher.of({
    start: (request) => dispatch((service) => service.start(request)),
    bootstrap: (request) => dispatch((service) => service.bootstrap(request)),
    steer: (request) => dispatch((service) => service.steer(request)),
    list: (request) => dispatch((service) => service.list(request)),
    cancel: (request) => dispatch((service) => service.cancel(request)),
    bind: (service) => Effect.sync(() => void (tasks = service)),
  })
})
