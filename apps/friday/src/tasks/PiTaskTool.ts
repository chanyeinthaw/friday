/* oxlint-disable anti-slop/no-unknown-parameters, effecttsgo/any-unknown-in-error-context -- Pi tool input and dispatcher failures cross the SDK boundary and are schema-decoded before use. */

import {
  ModelSelection,
  TaskId,
  TaskStatusFilter,
  ThinkingLevel,
  TurnId,
  WorkingDirectory,
  type ChannelThread,
  type ListTasksRequest,
  type TaskSummary,
} from '@friday/contracts/conversation'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { TaskToolDispatchError } from './TaskToolDispatcher.ts'
import type { TasksContract } from './Tasks.ts'

const TaskToolInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('start'),
    task: Schema.String,
    workingDirectory: WorkingDirectory,
    model: Schema.optionalKey(ModelSelection),
    thinkingLevel: Schema.optionalKey(ThinkingLevel),
  }),
  Schema.Struct({
    action: Schema.Literal('bootstrap'),
    task: Schema.String,
    model: Schema.optionalKey(ModelSelection),
    thinkingLevel: Schema.optionalKey(ThinkingLevel),
  }),
  Schema.Struct({ action: Schema.Literal('steer'), taskId: TaskId, message: Schema.String }),
  Schema.Struct({ action: Schema.Literal('list'), status: Schema.optionalKey(TaskStatusFilter) }),
  Schema.Struct({ action: Schema.Literal('cancel'), taskId: TaskId, reason: Schema.String }),
])

const decodeTaskToolInput = Schema.decodeUnknownEffect(TaskToolInput)
const decodeTurnId = Schema.decodeUnknownEffect(TurnId)

const ModelSelectionParameters = Type.Object({
  provider: Type.String({ description: 'Configured provider identifier.' }),
  modelId: Type.String({ description: 'Configured model identifier.' }),
})

const ThinkingLevelParameters = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
])

const TaskToolParameters = Type.Union([
  Type.Object({
    action: Type.Literal('start'),
    task: Type.String({
      description: 'Clear objective, context, expected result, and constraints.',
    }),
    workingDirectory: Type.String({
      description: 'Absolute working directory outside the channel workspace.',
    }),
    model: Type.Optional(ModelSelectionParameters),
    thinkingLevel: Type.Optional(ThinkingLevelParameters),
  }),
  Type.Object({
    action: Type.Literal('bootstrap'),
    task: Type.String({ description: 'Workspace preparation objective.' }),
    model: Type.Optional(ModelSelectionParameters),
    thinkingLevel: Type.Optional(ThinkingLevelParameters),
  }),
  Type.Object({ action: Type.Literal('steer'), taskId: Type.String(), message: Type.String() }),
  Type.Object({
    action: Type.Literal('list'),
    status: Type.Optional(
      Type.Union([Type.Literal('active'), Type.Literal('terminal'), Type.Literal('all')]),
    ),
  }),
  Type.Object({ action: Type.Literal('cancel'), taskId: Type.String(), reason: Type.String() }),
])

const taskSummary = (task: TaskSummary) => ({
  taskId: task.taskId,
  role: task.role,
  status: task.status,
  task: task.task,
  workingDirectory: task.workingDirectory,
  model: task.model,
  thinkingLevel: task.thinkingLevel,
  createdAt: task.createdAt,
  completedAt: task.completedAt,
})

const output = <A>(value: A) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: value,
})

type StartRequest = Parameters<TasksContract['start']>[0]
type BootstrapRequest = Parameters<TasksContract['bootstrap']>[0]
type SteerRequest = Parameters<TasksContract['steer']>[0]
type CancelRequest = Parameters<TasksContract['cancel']>[0]

export interface PiTaskOperations {
  readonly start: (request: StartRequest) => Effect.Effect<unknown, TaskToolDispatchError>
  readonly bootstrap: (request: BootstrapRequest) => Effect.Effect<unknown, TaskToolDispatchError>
  readonly steer: (request: SteerRequest) => Effect.Effect<void, TaskToolDispatchError>
  readonly list: (
    request: ListTasksRequest,
  ) => Effect.Effect<ReadonlyArray<TaskSummary>, TaskToolDispatchError>
  readonly cancel: (request: CancelRequest) => Effect.Effect<void, TaskToolDispatchError>
}

export interface MakePiTaskToolOptions {
  readonly thread: ChannelThread
  readonly tasks: PiTaskOperations
  readonly activeTurnId: () => TurnId | null
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

export const makePiTaskTool = (options: MakePiTaskToolOptions): ToolDefinition =>
  defineTool({
    name: 'task',
    label: 'Task',
    description:
      'Start background agent tasks, prepare workspaces, steer or cancel existing tasks, and list tasks for this channel thread.',
    promptSnippet: 'Use `task` to run delegated work in background agent threads.',
    parameters: TaskToolParameters,
    executionMode: 'parallel',
    execute: async (_toolCallId, rawInput) => {
      const input = await options.runPromise(decodeTaskToolInput(rawInput))
      const activeTurnId = options.activeTurnId()
      if (activeTurnId === null && (input.action === 'start' || input.action === 'bootstrap')) {
        throw new Error('A task can only be started from an active channel Turn.')
      }

      switch (input.action) {
        case 'start': {
          const base = {
            parentThreadId: options.thread.id,
            parentTurnId: await options.runPromise(decodeTurnId(activeTurnId)),
            task: input.task,
            workingDirectory: input.workingDirectory,
          }
          const withModel = input.model === undefined ? base : { ...base, model: input.model }
          const request: StartRequest =
            input.thinkingLevel === undefined
              ? withModel
              : { ...withModel, thinkingLevel: input.thinkingLevel }
          return output(await options.runPromise(options.tasks.start(request)))
        }
        case 'bootstrap': {
          const base = {
            parentThreadId: options.thread.id,
            parentTurnId: await options.runPromise(decodeTurnId(activeTurnId)),
            task: input.task,
          }
          const withModel = input.model === undefined ? base : { ...base, model: input.model }
          const request: BootstrapRequest =
            input.thinkingLevel === undefined
              ? withModel
              : { ...withModel, thinkingLevel: input.thinkingLevel }
          return output(await options.runPromise(options.tasks.bootstrap(request)))
        }
        case 'steer':
          await options.runPromise(
            options.tasks.steer({
              parentThreadId: options.thread.id,
              taskId: input.taskId,
              message: input.message,
            }),
          )
          return output({ taskId: input.taskId, status: 'steered' })
        case 'list': {
          const request: ListTasksRequest =
            input.status === undefined
              ? { parentThreadId: options.thread.id }
              : { parentThreadId: options.thread.id, status: input.status }
          const tasks = await options.runPromise(options.tasks.list(request))
          return output({ tasks: tasks.map(taskSummary) })
        }
        case 'cancel':
          await options.runPromise(
            options.tasks.cancel({
              parentThreadId: options.thread.id,
              taskId: input.taskId,
              reason: input.reason,
            }),
          )
          return output({ taskId: input.taskId, status: 'cancelled' })
      }
    },
  })
