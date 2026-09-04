import type { SteeringActivity, TokenUsage, Turn, TurnId } from '@friday/contracts/conversation'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  ThreadPersistence,
  type ThreadPersistenceContract,
  type ThreadPersistenceError,
} from './ThreadPersistence.ts'
import type {
  HarnessReloadOutcome,
  PromptRequest,
  ThreadRuntime,
  ThreadRuntimeEvent,
} from './ThreadRuntime.ts'

export type TerminalTurn =
  | {
      readonly status: 'completed'
      readonly turnId: TurnId
      readonly agentMessage: string
      readonly usage: TokenUsage | null
    }
  | {
      readonly status: 'interrupted'
      readonly turnId: TurnId
      readonly agentMessage: string | null
      readonly usage: TokenUsage | null
    }
  | {
      readonly status: 'failed'
      readonly turnId: TurnId
      readonly errorMessage: string
    }

export interface TurnHandle<EventError = never> {
  readonly turnId: TurnId
  readonly awaitTerminal: Effect.Effect<TerminalTurn, EventError | ThreadPersistenceError>
}

export interface ThreadCoordinatorContract<PromptError, EventError> {
  readonly prompt: (
    turn: Turn,
  ) => Effect.Effect<TurnHandle<EventError>, PromptError | ThreadPersistenceError>
  readonly steer: (
    turnId: Turn['id'],
    activity: SteeringActivity,
  ) => Effect.Effect<void, PromptError | ThreadPersistenceError>
  readonly cancel: (turnId: TurnId) => Effect.Effect<void, PromptError>
  readonly reload: () => Effect.Effect<HarnessReloadOutcome>
  readonly onEvent: (
    listener: (event: ThreadRuntimeEvent) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly start: Effect.Effect<void, never, Scope.Scope>
  readonly drain: Effect.Effect<void, EventError | ThreadPersistenceError>
}

const terminalTurnFromEvent = (event: ThreadRuntimeEvent): TerminalTurn | null => {
  switch (event.type) {
    case 'turn-completed':
      return {
        status: 'completed',
        turnId: event.turnId,
        agentMessage: event.agentMessage,
        usage: event.usage,
      }
    case 'turn-interrupted':
      return {
        status: 'interrupted',
        turnId: event.turnId,
        agentMessage: event.agentMessage,
        usage: event.usage,
      }
    case 'turn-failed':
      return {
        status: 'failed',
        turnId: event.turnId,
        errorMessage: event.errorMessage,
      }
    default:
      return null
  }
}

const persistRuntimeEvent = (
  persistence: ThreadPersistenceContract,
  event: ThreadRuntimeEvent,
): Effect.Effect<void, ThreadPersistenceError> => {
  switch (event.type) {
    case 'turn-started':
      return persistence.startTurn(event)
    case 'activity-started':
    case 'activity-updated':
    case 'activity-completed':
      return persistence.putActivitySnapshot(event.turnId, event.activity)
    case 'turn-completed':
      return persistence.completeTurn(event)
    case 'turn-interrupted':
      return persistence.interruptTurn(event)
    case 'turn-failed':
      return persistence.failTurn(event)
    default:
      return Effect.die(new Error('Unknown ThreadRuntime event'))
  }
}

export const makeThreadCoordinator = Effect.fn('makeThreadCoordinator')(function* <
  PromptError,
  EventError,
>(runtime: ThreadRuntime<PromptError, EventError>) {
  const persistence = yield* ThreadPersistence
  const coordinatorScope = yield* Effect.scope
  const eventListeners = new Set<(event: ThreadRuntimeEvent) => Effect.Effect<void>>()
  const terminalSignals = new Map<
    TurnId,
    Deferred.Deferred<TerminalTurn, EventError | ThreadPersistenceError>
  >()
  yield* persistence.setThreadHarnessSession({
    threadId: runtime.threadId,
    harnessSession: runtime.harnessSession,
  })

  const persistAndSignal = Effect.fn('ThreadCoordinator.persistAndSignal')(function* (
    event: ThreadRuntimeEvent,
  ) {
    yield* persistRuntimeEvent(persistence, event)
    yield* Effect.forEach(eventListeners, (listener) => listener(event), { discard: true })
    const terminal = terminalTurnFromEvent(event)
    if (terminal === null) return
    const signal = terminalSignals.get(event.turnId)
    if (!signal) return
    terminalSignals.delete(event.turnId)
    yield* Deferred.succeed(signal, terminal)
  })
  const failTerminalSignals = Effect.fn('ThreadCoordinator.failTerminalSignals')(function* (
    cause: EventError | ThreadPersistenceError,
  ) {
    const signals = Array.from(terminalSignals.values())
    terminalSignals.clear()
    yield* Effect.forEach(signals, (signal) => Deferred.fail(signal, cause), {
      discard: true,
    })
  })
  const drain = Stream.runForEach(runtime.events, persistAndSignal).pipe(
    Effect.tapError(failTerminalSignals),
  )

  return {
    prompt: (turn) =>
      Effect.gen(function* () {
        const signal = yield* Deferred.make<TerminalTurn, EventError | ThreadPersistenceError>()
        const request: PromptRequest = {
          turnId: turn.id,
          message: turn.input,
          mode: 'turn',
        }

        yield* persistence.createTurn(turn)
        terminalSignals.set(turn.id, signal)

        const deliver = runtime.prompt(request).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const completedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso))
              const terminal: TerminalTurn = {
                status: 'failed',
                turnId: turn.id,
                errorMessage: String(cause),
              }
              yield* persistence
                .failTurn({
                  turnId: turn.id,
                  errorMessage: terminal.errorMessage,
                  completedAt,
                })
                .pipe(
                  Effect.tapError((persistenceError) => Deferred.fail(signal, persistenceError)),
                )
              terminalSignals.delete(turn.id)
              yield* Deferred.succeed(signal, terminal)
              yield* Effect.logError('Thread prompt delivery failed', cause)
            }),
          ),
        )
        yield* deliver.pipe(Effect.forkIn(coordinatorScope))
        yield* Effect.yieldNow

        return {
          turnId: turn.id,
          awaitTerminal: Deferred.await(signal),
        }
      }),
    cancel: runtime.cancel,
    reload: runtime.reload,
    onEvent: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => void eventListeners.add(listener)),
        () => Effect.sync(() => void eventListeners.delete(listener)),
      ).pipe(Effect.asVoid),
    steer: (turnId, activity) => {
      const request: PromptRequest = {
        turnId,
        message: activity.message,
      }

      return persistence
        .putActivitySnapshot(turnId, activity)
        .pipe(Effect.andThen(runtime.prompt(request)))
    },
    start: drain.pipe(
      Effect.catchCause((cause) => Effect.logError('Thread coordinator drain terminated', cause)),
      Effect.forkScoped,
      Effect.asVoid,
    ),
    drain,
  } satisfies ThreadCoordinatorContract<PromptError, EventError>
})
