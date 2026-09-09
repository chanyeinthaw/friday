import * as Schema from 'effect/Schema'

import { AgentRole, WorkingDirectory } from './thread.ts'
import { ThreadId, TurnId } from './ids.ts'
import { ModelSelection, SubagentProfileName, ThinkingLevel } from './model.ts'
import { IsoDateTime, NonNegativeInt, PositiveInt } from './scalar.ts'

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

export const SetTaskModelRequest = Schema.Struct({
  parentThreadId: ThreadId,
  taskId: TaskId,
  profile: SubagentProfileName,
})
export type SetTaskModelRequest = typeof SetTaskModelRequest.Type

export const SetTaskModelResult = Schema.Struct({
  taskId: TaskId,
  profile: SubagentProfileName,
  model: ModelSelection,
  thinkingLevel: ThinkingLevel,
})
export type SetTaskModelResult = typeof SetTaskModelResult.Type

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

export const TaskInspectCursor = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Schema.brand('TaskInspectCursor'),
)
export type TaskInspectCursor = typeof TaskInspectCursor.Type

export const InspectTaskLimit = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(20)),
)
export type InspectTaskLimit = typeof InspectTaskLimit.Type

export const TaskInspectDefaultLimit = 5

export const TaskInspectMaxLimit = 20

export const InspectTaskRequest = Schema.Struct({
  parentThreadId: ThreadId,
  taskId: TaskId,
  cursor: Schema.optionalKey(TaskInspectCursor),
  limit: Schema.optionalKey(InspectTaskLimit),
})
export type InspectTaskRequest = typeof InspectTaskRequest.Type

export const TaskOutline = Schema.Struct({
  taskId: TaskId,
  role: AgentRole,
  profile: Schema.optionalKey(SubagentProfileName),
  status: TaskStatus,
  workspacePath: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  mayWrite: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  runtimePresent: Schema.Boolean,
  activeTurns: NonNegativeInt,
  warnings: Schema.Array(Schema.String),
})
export type TaskOutline = typeof TaskOutline.Type

export const TaskToolActivitySummary = Schema.Struct({
  kind: Schema.Literal('tool'),
  toolName: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  summary: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  status: Schema.Literals(['active', 'completed', 'failed']),
  isError: Schema.Boolean,
  turnSequence: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
})
export type TaskToolActivitySummary = typeof TaskToolActivitySummary.Type

export const TaskSteeringActivitySummary = Schema.Struct({
  kind: Schema.Literal('steering'),
  summary: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  turnSequence: PositiveInt,
  createdAt: IsoDateTime,
})
export type TaskSteeringActivitySummary = typeof TaskSteeringActivitySummary.Type

export const TaskProgressActivitySummary = Schema.Struct({
  kind: Schema.Literal('progress'),
  summary: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  turnSequence: PositiveInt,
  createdAt: IsoDateTime,
})
export type TaskProgressActivitySummary = typeof TaskProgressActivitySummary.Type

export const TaskActivitySummary = Schema.Union([
  TaskToolActivitySummary,
  TaskSteeringActivitySummary,
  TaskProgressActivitySummary,
])
export type TaskActivitySummary = typeof TaskActivitySummary.Type

export const InspectTaskResult = Schema.Struct({
  outline: TaskOutline,
  activities: Schema.Array(TaskActivitySummary),
  nextCursor: Schema.NullOr(TaskInspectCursor),
  hasMore: Schema.Boolean,
})
export type InspectTaskResult = typeof InspectTaskResult.Type
