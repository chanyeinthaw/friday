/* oxlint-disable anti-slop/no-unknown-parameters, effecttsgo/any-unknown-in-error-context -- Pi tool input and dispatcher failures cross the SDK boundary and are schema-decoded before use. */

import {
  InspectTaskLimit,
  SubagentProfileName,
  TaskId,
  TaskInspectCursor,
  TaskStatusFilter,
  TurnId,
  WorkingDirectory,
  type ChannelThread,
  type InspectTaskResult,
  type ListTasksRequest,
  type SetTaskModelRequest,
  type SetTaskModelResult,
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
    mayWrite: Schema.optionalKey(Schema.Boolean),
    profile: Schema.optionalKey(SubagentProfileName),
  }),
  Schema.Struct({
    action: Schema.Literal('bootstrap'),
    task: Schema.String,
    profile: Schema.optionalKey(SubagentProfileName),
  }),
  Schema.Struct({ action: Schema.Literal('steer'), taskId: TaskId, message: Schema.String }),
  Schema.Struct({ action: Schema.Literal('list'), status: Schema.optionalKey(TaskStatusFilter) }),
  Schema.Struct({ action: Schema.Literal('cancel'), taskId: TaskId, reason: Schema.String }),
  Schema.Struct({
    action: Schema.Literal('inspect'),
    taskId: TaskId,
    cursor: Schema.optionalKey(TaskInspectCursor),
    limit: Schema.optionalKey(InspectTaskLimit),
  }),
  Schema.Struct({
    action: Schema.Literal('set-model'),
    taskId: TaskId,
    profile: SubagentProfileName,
  }),
])

const decodeTaskToolInput = Schema.decodeUnknownEffect(TaskToolInput)
const decodeTurnId = Schema.decodeUnknownEffect(TurnId)

const TaskToolParameters = Type.Union([
  Type.Object({
    action: Type.Literal('start'),
    task: Type.String({
      description: 'Clear objective, context, expected result, and constraints.',
    }),
    workingDirectory: Type.String({
      description:
        'Absolute directory inside the channel workspace. The workspace root is allowed.',
    }),
    mayWrite: Type.Optional(
      Type.Boolean({
        description:
          'Whether the task may modify files or Git state. Defaults to true. Set false for read-only inspection so compatible tasks can share a worktree.',
      }),
    ),
    profile: Type.Optional(
      Type.String({ description: "Configured subagent profile name. Defaults to 'primary'." }),
    ),
  }),
  Type.Object({
    action: Type.Literal('bootstrap'),
    task: Type.String({ description: 'Workspace preparation objective.' }),
    profile: Type.Optional(
      Type.String({ description: "Configured subagent profile name. Defaults to 'primary'." }),
    ),
  }),
  Type.Object({ action: Type.Literal('steer'), taskId: Type.String(), message: Type.String() }),
  Type.Object({
    action: Type.Literal('list'),
    status: Type.Optional(
      Type.Union([Type.Literal('active'), Type.Literal('terminal'), Type.Literal('all')]),
    ),
  }),
  Type.Object({ action: Type.Literal('cancel'), taskId: Type.String(), reason: Type.String() }),
  Type.Object({
    action: Type.Literal('set-model'),
    taskId: Type.String({
      minLength: 1,
      pattern: '^\\S(?:[\\s\\S]*\\S)?$',
      description: 'Task identifier returned by a previous start.',
    }),
    profile: Type.String({
      description:
        'Exact configured subagent profile name the task will use from now on. Only configured profiles are accepted; arbitrary model identifiers are rejected.',
    }),
  }),
  Type.Object({
    action: Type.Literal('inspect'),
    taskId: Type.String({
      minLength: 1,
      pattern: '^\\S(?:[\\s\\S]*\\S)?$',
      description: 'Task identifier returned by a previous start.',
    }),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        pattern: '^\\S(?:[\\s\\S]*\\S)?$',
        description:
          'Opaque cursor from a previous inspect result. Omit for the latest activities; pass through only to read older history.',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 20,
        description: 'Maximum activities to return. Defaults to 5, maximum 20.',
      }),
    ),
  }),
])

const taskSummary = (task: TaskSummary) => {
  const base = {
    taskId: task.taskId,
    role: task.role,
    status: task.status,
    task: task.task,
    workingDirectory: task.workingDirectory,
    mayWrite: task.mayWrite,
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    createdAt: task.createdAt,
    completedAt: task.completedAt,
  }
  return task.profile === undefined ? base : { ...base, profile: task.profile }
}

const output = <A>(value: A) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  details: value,
})

type StartRequest = Parameters<TasksContract['start']>[0]
type BootstrapRequest = Parameters<TasksContract['bootstrap']>[0]
type SteerRequest = Parameters<TasksContract['steer']>[0]
type CancelRequest = Parameters<TasksContract['cancel']>[0]
type InspectRequest = Parameters<TasksContract['inspect']>[0]

const inspectResult = (result: InspectTaskResult) => {
  const outlineBase = {
    taskId: result.outline.taskId,
    role: result.outline.role,
    status: result.outline.status,
    workspacePath: result.outline.workspacePath,
    mayWrite: result.outline.mayWrite,
    createdAt: result.outline.createdAt,
    updatedAt: result.outline.updatedAt,
    completedAt: result.outline.completedAt,
    runtimePresent: result.outline.runtimePresent,
    activeTurns: result.outline.activeTurns,
    warnings: result.outline.warnings,
  }
  const outline =
    result.outline.profile === undefined
      ? outlineBase
      : { ...outlineBase, profile: result.outline.profile }
  return {
    outline,
    activities: result.activities,
    nextCursor: result.nextCursor,
    hasMore: result.hasMore,
  }
}

export interface PiTaskOperations {
  readonly start: (request: StartRequest) => Effect.Effect<unknown, TaskToolDispatchError>
  readonly bootstrap: (request: BootstrapRequest) => Effect.Effect<unknown, TaskToolDispatchError>
  readonly steer: (request: SteerRequest) => Effect.Effect<void, TaskToolDispatchError>
  readonly list: (
    request: ListTasksRequest,
  ) => Effect.Effect<ReadonlyArray<TaskSummary>, TaskToolDispatchError>
  readonly cancel: (request: CancelRequest) => Effect.Effect<void, TaskToolDispatchError>
  readonly inspect: (
    request: InspectRequest,
  ) => Effect.Effect<InspectTaskResult, TaskToolDispatchError>
  readonly setModel: (
    request: SetTaskModelRequest,
  ) => Effect.Effect<SetTaskModelResult, TaskToolDispatchError>
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
      'Start background agent tasks, prepare workspaces, steer, cancel, or switch the model of existing tasks, list tasks for this channel thread, and inspect one known task with a safe outline and activity summaries. Model switches only accept configured subagent profile names.',
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
            mayWrite: input.mayWrite ?? true,
          }
          const request: StartRequest =
            input.profile === undefined ? base : { ...base, profile: input.profile }
          return output(await options.runPromise(options.tasks.start(request)))
        }
        case 'bootstrap': {
          const base = {
            parentThreadId: options.thread.id,
            parentTurnId: await options.runPromise(decodeTurnId(activeTurnId)),
            task: input.task,
          }
          const request: BootstrapRequest =
            input.profile === undefined ? base : { ...base, profile: input.profile }
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
        case 'set-model':
          return output(
            await options.runPromise(
              options.tasks.setModel({
                parentThreadId: options.thread.id,
                taskId: input.taskId,
                profile: input.profile,
              }),
            ),
          )
        case 'inspect': {
          const base = {
            parentThreadId: options.thread.id,
            taskId: input.taskId,
          }
          const withCursor: InspectRequest =
            input.cursor === undefined ? base : { ...base, cursor: input.cursor }
          const request: InspectRequest =
            input.limit === undefined ? withCursor : { ...withCursor, limit: input.limit }
          const result = await options.runPromise(options.tasks.inspect(request))
          return output(inspectResult(result))
        }
      }
    },
  })
