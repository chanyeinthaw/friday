import * as Schema from 'effect/Schema'

import { AgentRole, WorkingDirectory } from './thread.ts'
import { ThreadId, TurnId } from './ids.ts'
import { ModelSelection, SubagentProfileName, ThinkingLevel } from './model.ts'
import { IsoDateTime } from './scalar.ts'

export const TaskId = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Schema.brand('TaskId'),
)
export type TaskId = typeof TaskId.Type

export const TaskStatus = Schema.Literals([
  'pending',
  'running',
  'completed',
  'interrupted',
  'failed',
])
export type TaskStatus = typeof TaskStatus.Type

export const TaskStatusFilter = Schema.Literals(['active', 'terminal', 'all'])
export type TaskStatusFilter = typeof TaskStatusFilter.Type

export const StartTaskRequest = Schema.Struct({
  parentThreadId: ThreadId,
  parentTurnId: TurnId,
  task: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  workingDirectory: WorkingDirectory,
  mayWrite: Schema.optionalKey(Schema.Boolean),
  profile: Schema.optionalKey(SubagentProfileName),
})
export type StartTaskRequest = typeof StartTaskRequest.Type

export const BootstrapTaskRequest = Schema.Struct({
  parentThreadId: ThreadId,
  parentTurnId: TurnId,
  task: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  profile: Schema.optionalKey(SubagentProfileName),
})
export type BootstrapTaskRequest = typeof BootstrapTaskRequest.Type

export const SteerTaskRequest = Schema.Struct({
  parentThreadId: ThreadId,
  taskId: TaskId,
  message: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
})
export type SteerTaskRequest = typeof SteerTaskRequest.Type

export const ListTasksRequest = Schema.Struct({
  parentThreadId: ThreadId,
  status: Schema.optionalKey(TaskStatusFilter),
})
export type ListTasksRequest = typeof ListTasksRequest.Type

export const CancelTaskRequest = Schema.Struct({
  parentThreadId: ThreadId,
  taskId: TaskId,
  reason: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
})
export type CancelTaskRequest = typeof CancelTaskRequest.Type

export const StartedTask = Schema.Struct({
  taskId: TaskId,
  status: Schema.Literal('pending'),
})
export type StartedTask = typeof StartedTask.Type

export const TaskSummary = Schema.Struct({
  taskId: TaskId,
  role: AgentRole,
  profile: Schema.optionalKey(SubagentProfileName),
  status: TaskStatus,
  task: Schema.String,
  workingDirectory: WorkingDirectory,
  mayWrite: Schema.Boolean,
  model: ModelSelection,
  thinkingLevel: ThinkingLevel,
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
})
export type TaskSummary = typeof TaskSummary.Type
