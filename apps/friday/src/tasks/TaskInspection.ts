/* oxlint-disable effecttsgo/node-builtin-import -- Workspace-relative presentation follows Node path semantics. */

import {
  TaskInspectCursor,
  TaskId,
  type Activity,
  type AgentThread,
  type ChannelThread,
  type TaskActivitySummary,
  type TaskOutline,
  type Turn,
} from '@friday/contracts/conversation'
import * as Encoding from 'effect/Encoding'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { relative } from 'node:path'

import type { ThreadRuntimeObservation } from '../conversation/ThreadRuntimePool.ts'
import { isActiveTaskStatus } from './TaskPolicy.ts'

export type TaskInspectPositionKind = 'activity' | 'lifecycle'

export interface TaskInspectCursorPosition {
  readonly turnSequence: number
  readonly sequence: number
  readonly kind: TaskInspectPositionKind
}

export interface TaskInspectSnapshotBoundary {
  readonly turnSequence: number
  readonly maxActivitySequence: number
  readonly hasLifecycle: boolean
}

export interface DecodedInspectCursor {
  readonly boundary: ReadonlyArray<TaskInspectSnapshotBoundary>
  readonly after: TaskInspectCursorPosition
}

export interface OrderedTaskActivity {
  readonly summary: TaskActivitySummary
  readonly turnSequence: number
  readonly sequence: number
  readonly positionKind: TaskInspectPositionKind
}

type ToolCall = Extract<Activity, { readonly type: 'tool-call' }>
type ToolResult = Extract<Activity, { readonly type: 'tool-result' }>

interface ToolPair {
  readonly call?: ToolCall
  readonly result?: ToolResult
}

const CursorPosition = Schema.Struct({
  turnSequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  kind: Schema.Literals(['activity', 'lifecycle']),
})
const SnapshotBoundary = Schema.Struct({
  turnSequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  maxActivitySequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  hasLifecycle: Schema.Boolean,
})
const CursorPayload = Schema.Struct({
  taskId: TaskId,
  boundary: Schema.Array(SnapshotBoundary),
  after: CursorPosition,
})
const CursorPayloadJson = Schema.fromJsonString(CursorPayload)
const decodeCursorPayloadOption = Schema.decodeUnknownOption(CursorPayloadJson)
const encodeCursorPayloadSync = Schema.encodeSync(CursorPayloadJson)
const decodeCursorSync = Schema.decodeSync(TaskInspectCursor)

const positionKindRank = (kind: TaskInspectPositionKind): number => (kind === 'lifecycle' ? 1 : 0)

const compareInspectPositions = (
  left: TaskInspectCursorPosition,
  right: TaskInspectCursorPosition,
): number => {
  if (left.turnSequence !== right.turnSequence) return left.turnSequence - right.turnSequence
  if (left.sequence !== right.sequence) return left.sequence - right.sequence
  return positionKindRank(left.kind) - positionKindRank(right.kind)
}

const snapshotBoundaryForTurn = (
  boundary: ReadonlyArray<TaskInspectSnapshotBoundary>,
  turnSequence: number,
): TaskInspectSnapshotBoundary | undefined =>
  boundary.find((entry) => entry.turnSequence === turnSequence)

/** Returns whether a position was present in the immutable snapshot in a cursor. */
export const isWithinInspectSnapshot = (
  position: TaskInspectCursorPosition,
  boundary: ReadonlyArray<TaskInspectSnapshotBoundary>,
): boolean => {
  const turn = snapshotBoundaryForTurn(boundary, position.turnSequence)
  if (turn === undefined) return false
  if (position.kind === 'activity') return position.sequence <= turn.maxActivitySequence
  return turn.hasLifecycle && position.sequence === turn.maxActivitySequence + 1
}

/** Returns whether a position is older than the last position returned by a page. */
export const isOlderThanInspectCursor = (
  position: TaskInspectCursorPosition,
  after: TaskInspectCursorPosition,
): boolean => compareInspectPositions(position, after) < 0

export const isSameInspectPosition = (
  left: TaskInspectCursorPosition,
  right: TaskInspectCursorPosition,
): boolean => compareInspectPositions(left, right) === 0

/** Maps a current activity to its stable position in an inspection snapshot. */
export const inspectPositionForActivity = (
  activity: OrderedTaskActivity,
  boundary: ReadonlyArray<TaskInspectSnapshotBoundary>,
): TaskInspectCursorPosition => {
  const snapshot = snapshotBoundaryForTurn(boundary, activity.turnSequence)
  return {
    turnSequence: activity.turnSequence,
    sequence:
      activity.positionKind === 'lifecycle' && snapshot !== undefined
        ? snapshot.maxActivitySequence + 1
        : activity.sequence,
    kind: activity.positionKind,
  }
}

/** Presents the task directory relative to its channel workspace. Never returns an absolute path. */
export const relativeWorkspacePath = (channelWorkspace: string, taskDirectory: string): string => {
  const path = relative(channelWorkspace, taskDirectory).trim()
  if (path.length === 0) return '.'
  return path
}

const pairToolCalls = (activities: Turn['activities']): Map<string, ToolPair> => {
  const calls = new Map<string, ToolPair>()
  for (const activity of activities) {
    if (activity.type !== 'tool-call' && activity.type !== 'tool-result') continue
    const existing = calls.get(activity.callId) ?? {}
    calls.set(
      activity.callId,
      activity.type === 'tool-call'
        ? { ...existing, call: activity }
        : { ...existing, result: activity },
    )
  }
  return calls
}

const toolNameForPair = (pair: ToolPair): string => pair.call?.toolName ?? '(unknown tool)'

const timestampsForPair = (
  pair: ToolPair,
): { readonly createdAt: Turn['requestedAt']; readonly updatedAt: Turn['requestedAt'] } | null => {
  const createdAt = pair.call?.createdAt ?? pair.result?.createdAt
  const updatedAt = pair.result?.updatedAt ?? pair.call?.updatedAt
  if (createdAt === undefined || updatedAt === undefined) return null
  return { createdAt, updatedAt }
}

const completedAtForPair = (pair: ToolPair, completed: boolean): ToolCall['createdAt'] | null => {
  if (!completed) return null
  return pair.result?.completedAt ?? pair.call?.completedAt ?? null
}

/** Uses the tool-call position so completing a tool does not move it between pages. */
const sequenceForPair = (pair: ToolPair): number =>
  pair.call?.sequence ?? pair.result?.sequence ?? 0

/** Safe one-line description for a tool activity. Arguments and results are never included. */
const summarizeTool = (toolName: string): string => `Ran ${toolName.trim()}`

const toolSummaryForPair = (turn: Turn, pair: ToolPair): OrderedTaskActivity | null => {
  const timestamps = timestampsForPair(pair)
  if (timestamps === null) return null
  const toolName = toolNameForPair(pair)
  const result = pair.result
  const completed = result?.status === 'completed'
  const status: 'active' | 'completed' | 'failed' =
    result?.status !== 'completed' ? 'active' : result.isError ? 'failed' : 'completed'
  return {
    summary: {
      kind: 'tool',
      toolName,
      summary: summarizeTool(toolName),
      status,
      isError: result?.isError ?? false,
      turnSequence: turn.sequence,
      createdAt: timestamps.createdAt,
      updatedAt: timestamps.updatedAt,
      completedAt: completedAtForPair(pair, completed),
    },
    turnSequence: turn.sequence,
    sequence: sequenceForPair(pair),
    positionKind: 'activity',
  }
}

const toolSummariesForTurn = (turn: Turn): Array<OrderedTaskActivity> => {
  const summaries: Array<OrderedTaskActivity> = []
  for (const pair of pairToolCalls(turn.activities).values()) {
    const summary = toolSummaryForPair(turn, pair)
    if (summary !== null) summaries.push(summary)
  }
  return summaries
}

const steeringSummary = (
  turn: Turn,
  activity: Extract<Activity, { readonly type: 'steering' }>,
): OrderedTaskActivity => ({
  summary: {
    kind: 'steering',
    summary: 'Received steering input.',
    turnSequence: turn.sequence,
    createdAt: activity.createdAt,
  },
  turnSequence: turn.sequence,
  sequence: activity.sequence,
  positionKind: 'activity',
})

const commentarySummary = (
  turn: Turn,
  activity: Extract<Activity, { readonly type: 'commentary' }>,
): OrderedTaskActivity => ({
  summary: {
    kind: 'progress',
    summary: 'Assistant posted a progress update.',
    turnSequence: turn.sequence,
    createdAt: activity.createdAt,
  },
  turnSequence: turn.sequence,
  sequence: activity.sequence,
  positionKind: 'activity',
})

const messageSummariesForTurn = (turn: Turn): Array<OrderedTaskActivity> => {
  const summaries: Array<OrderedTaskActivity> = []
  for (const activity of turn.activities) {
    if (activity.type === 'steering') summaries.push(steeringSummary(turn, activity))
    else if (activity.type === 'commentary') summaries.push(commentarySummary(turn, activity))
  }
  return summaries
}

const lifecycleSummaryForTurn = (turn: Turn): OrderedTaskActivity | null => {
  if (turn.status !== 'completed' && turn.status !== 'interrupted' && turn.status !== 'failed') {
    return null
  }
  const label =
    turn.status === 'completed'
      ? `Turn ${turn.sequence} completed.`
      : turn.status === 'interrupted'
        ? `Turn ${turn.sequence} was interrupted.`
        : `Turn ${turn.sequence} failed.`
  const maxSequence = turn.activities.reduce(
    (max, activity) => Math.max(max, activity.sequence),
    -1,
  )
  return {
    summary: {
      kind: 'progress',
      summary: label,
      turnSequence: turn.sequence,
      createdAt: turn.completedAt ?? turn.requestedAt,
    },
    turnSequence: turn.sequence,
    sequence: maxSequence + 1,
    positionKind: 'lifecycle',
  }
}

export const buildOrderedTaskActivities = (
  turns: ReadonlyArray<Turn>,
): ReadonlyArray<OrderedTaskActivity> => {
  const ordered: Array<OrderedTaskActivity> = []
  for (const turn of turns) {
    ordered.push(...toolSummariesForTurn(turn), ...messageSummariesForTurn(turn))
    const lifecycle = lifecycleSummaryForTurn(turn)
    if (lifecycle !== null) ordered.push(lifecycle)
  }
  return ordered.toSorted((left, right) => {
    if (left.turnSequence !== right.turnSequence) {
      return right.turnSequence - left.turnSequence
    }
    if (left.sequence !== right.sequence) return right.sequence - left.sequence
    return positionKindRank(right.positionKind) - positionKindRank(left.positionKind)
  })
}

export const buildTaskActivities = (
  turns: ReadonlyArray<Turn>,
): ReadonlyArray<TaskActivitySummary> =>
  buildOrderedTaskActivities(turns).map(({ summary }) => summary)

/** Captures each turn's newest raw activity and whether its terminal lifecycle item was visible. */
export const buildInspectSnapshotBoundary = (
  ordered: ReadonlyArray<OrderedTaskActivity>,
): ReadonlyArray<TaskInspectSnapshotBoundary> => {
  const boundaries = new Map<number, { maxActivitySequence: number; hasLifecycle: boolean }>()
  for (const activity of ordered) {
    const existing = boundaries.get(activity.turnSequence) ?? {
      maxActivitySequence: 0,
      hasLifecycle: false,
    }
    if (activity.positionKind === 'lifecycle') existing.hasLifecycle = true
    else existing.maxActivitySequence = Math.max(existing.maxActivitySequence, activity.sequence)
    boundaries.set(activity.turnSequence, existing)
  }
  return Array.from(boundaries, ([turnSequence, boundary]) => ({
    turnSequence,
    ...boundary,
  })).toSorted((left, right) => left.turnSequence - right.turnSequence)
}

/** Opaque cursor binding a task to an immutable snapshot boundary and a keyset position. */
export const encodeInspectCursor = (
  taskId: TaskId,
  boundary: ReadonlyArray<TaskInspectSnapshotBoundary>,
  after: TaskInspectCursorPosition,
): TaskInspectCursor => {
  const json = encodeCursorPayloadSync({ taskId, boundary, after })
  return decodeCursorSync(Encoding.encodeBase64Url(json))
}

export const decodeInspectCursor = (
  cursor: TaskInspectCursor,
  taskId: TaskId,
): Option.Option<DecodedInspectCursor> => {
  const jsonResult = Encoding.decodeBase64UrlString(cursor)
  if (!Result.isSuccess(jsonResult)) return Option.none()
  const payload = Option.getOrUndefined(decodeCursorPayloadOption(Result.getOrThrow(jsonResult)))
  if (payload === undefined || payload.taskId !== taskId || payload.boundary.length === 0) {
    return Option.none()
  }
  const orderedBoundary = payload.boundary.toSorted(
    (left, right) => left.turnSequence - right.turnSequence,
  )
  const uniqueBoundary = orderedBoundary.every(
    (entry, index) =>
      index === 0 || orderedBoundary[index - 1]?.turnSequence !== entry.turnSequence,
  )
  if (!uniqueBoundary || !isWithinInspectSnapshot(payload.after, payload.boundary)) {
    return Option.none()
  }
  return Option.some({ boundary: payload.boundary, after: payload.after })
}

interface OutlineInput {
  readonly taskId: TaskId
  readonly thread: AgentThread
  readonly parent: ChannelThread
  readonly latestTurn: Turn
  readonly runtime: ThreadRuntimeObservation
}

export const buildTaskOutline = (input: OutlineInput): TaskOutline => {
  const warnings: Array<string> = []
  const latestIsActive = isActiveTaskStatus(input.latestTurn.status)
  if (input.thread.status === 'closed' && latestIsActive) {
    warnings.push(
      `Task thread is closed but its latest turn is still ${input.latestTurn.status}; progress may be stale.`,
    )
  }
  if (latestIsActive && !input.runtime.runtimePresent) {
    warnings.push('No live runtime is currently observed; persisted progress may be stale.')
  } else if (latestIsActive && input.runtime.activeTurns === 0) {
    warnings.push('No active live turn is currently observed; persisted progress may be stale.')
  }
  const base = {
    taskId: input.taskId,
    role: input.thread.role,
    status: input.latestTurn.status,
    workspacePath: relativeWorkspacePath(
      input.parent.workingDirectory,
      input.thread.workingDirectory,
    ),
    mayWrite: input.thread.mayWrite ?? true,
    createdAt: input.thread.createdAt,
    updatedAt: input.thread.updatedAt,
    completedAt: input.latestTurn.completedAt,
    runtimePresent: input.runtime.runtimePresent,
    activeTurns: input.runtime.activeTurns,
    warnings,
  }
  return input.thread.subagentProfile === undefined
    ? base
    : { ...base, profile: input.thread.subagentProfile }
}
