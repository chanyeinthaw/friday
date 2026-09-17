import {
  ActivityId,
  SteeringActivity,
  Turn,
  TurnId,
  type AgentThread,
  type CancelTaskRequest,
  type SetTaskModelRequest,
  type SetTaskModelResult,
  type SteerTaskRequest,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { TaskCompletion } from './TaskCompletion.ts'
import type { MakeTasksOptions } from './TaskDependencies.ts'
import { taskError } from './TaskError.ts'
import { requireChannelThread, requireOwnedTask } from './TaskOperations.ts'
import { isActiveTaskStatus } from './TaskPolicy.ts'

const decodeActivityId = Schema.decodeUnknownEffect(ActivityId)
const decodeSteeringActivity = Schema.decodeUnknownEffect(SteeringActivity)
const decodeTurn = Schema.decodeUnknownEffect(Turn)
const decodeTurnId = Schema.decodeUnknownEffect(TurnId)

export const makeTaskControl = (options: MakeTasksOptions, completion: TaskCompletion) => {
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
    if (Option.isNone(latest)) {
      return yield* taskError('task-not-active', `Task '${request.taskId}' has no Turns.`, 'steer')
    }
    const turn = latest.value
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
    const parent = yield* requireChannelThread(options.persistence, request.parentThreadId)
    const first = yield* options.persistence.getFirstTurn(thread.id)
    const originalTask = Option.isSome(first) ? first.value.input.content.text : undefined
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
    return yield* completion.watch({
      parent,
      taskId: request.taskId,
      threadId: thread.id,
      task: originalTask,
      awaitTerminal: handle.awaitTerminal,
      failureMessage: 'Task continuation delivery failed',
    })
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
    const parent = yield* requireChannelThread(options.persistence, request.parentThreadId)
    return yield* completion.cancel(
      parent,
      request.taskId,
      coordinator
        .cancel(turn.id)
        .pipe(
          Effect.mapError((cause) =>
            taskError(
              'start-failed',
              `Failed to cancel task '${request.taskId}': ${String(cause)}`,
              'cancel',
            ),
          ),
        ),
    )
  })

  const setModel = Effect.fn('Tasks.setModel')(function* (request: SetTaskModelRequest) {
    yield* requireChannelThread(options.persistence, request.parentThreadId)
    const resolved = yield* options.models.resolve(request.profile)
    if (Option.isNone(resolved)) {
      return yield* taskError(
        'model-not-configured',
        `Subagent profile '${request.profile}' is not configured.`,
        'set-model',
      )
    }
    const profile = resolved.value
    const thread = yield* requireOwnedTask(
      options.persistence,
      'set-model',
      request.parentThreadId,
      request.taskId,
    )
    const latest = yield* options.persistence.getLatestTurn(thread.id)
    const turn = yield* Option.match(latest, {
      onNone: () =>
        Effect.fail(
          taskError('task-not-active', `Task '${request.taskId}' has no Turns.`, 'set-model'),
        ),
      onSome: Effect.succeed,
    })
    if (!isActiveTaskStatus(turn.status)) {
      return yield* taskError(
        'task-not-active',
        `Task '${request.taskId}' is already ${turn.status}.`,
        'set-model',
      )
    }
    if (
      thread.subagentProfile === profile.name &&
      thread.model.provider === profile.model.provider &&
      thread.model.modelId === profile.model.modelId &&
      thread.thinkingLevel === profile.thinkingLevel
    ) {
      return {
        taskId: request.taskId,
        profile: profile.name,
        model: profile.model,
        thinkingLevel: profile.thinkingLevel,
      } satisfies SetTaskModelResult
    }
    // A running Turn finishes on its current model. The runtime pool recycles
    // the idle harness session before the next execution uses this profile.
    yield* options.persistence.setThreadModel({
      threadId: thread.id,
      model: profile.model,
      thinkingLevel: profile.thinkingLevel,
      subagentProfile: profile.name,
      updatedAt: yield* options.now,
    })
    return {
      taskId: request.taskId,
      profile: profile.name,
      model: profile.model,
      thinkingLevel: profile.thinkingLevel,
    } satisfies SetTaskModelResult
  })

  return { steer, cancel, setModel }
}
