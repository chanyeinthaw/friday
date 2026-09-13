/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas use the canonical _tag discriminator. */

import {
  ActivityId,
  SteeringActivity,
  Turn,
  TurnId,
  type ChannelThread,
  type InputMessage,
  type SteeringActivity as SteeringActivityType,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import * as PartitionedSemaphore from 'effect/PartitionedSemaphore'
import * as Schema from 'effect/Schema'

import { Friday } from '../Friday.ts'
import { ChannelProgress } from './ChannelProgress.ts'
import { isSteerRejected } from './ThreadRuntime.ts'
import type { TerminalTurn } from './ThreadCoordinator.ts'
import { ThreadPersistence, type ThreadPersistenceError } from './ThreadPersistence.ts'
import type { ThreadRuntimeError } from './ThreadRuntimes.ts'
import { PlatformNotFoundError, PlatformOperationError } from '../platforms/PlatformRegistry.ts'

const decodeTurn = Schema.decodeUnknownSync(Turn)
const decodeSteeringActivity = Schema.decodeUnknownSync(SteeringActivity)
const decodeTurnId = Schema.decodeUnknownSync(TurnId)
const decodeActivityId = Schema.decodeUnknownSync(ActivityId)
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

export type ChannelTurnError =
  | ThreadRuntimeError
  | ThreadPersistenceError
  | PlatformError.PlatformError
  | PlatformNotFoundError
  | PlatformOperationError

export interface AcceptChannelTurnRequest {
  readonly thread: ChannelThread
  readonly message: InputMessage
}

export interface ChannelTurnsContract {
  readonly accept: (request: AcceptChannelTurnRequest) => Effect.Effect<void, ChannelTurnError>
}

export class ChannelTurns extends Context.Service<ChannelTurns, ChannelTurnsContract>()(
  'friday/conversation/ChannelTurns',
) {}

const isActiveTurn = (turn: TurnType): boolean =>
  turn.status === 'pending' || turn.status === 'running'

const logTerminal = (thread: ChannelThread, terminal: TerminalTurn) =>
  terminal.status === 'completed'
    ? Effect.logInfo('turn.completed').pipe(
        Effect.annotateLogs({
          threadId: thread.id,
          turnId: terminal.turnId,
          inputTokens: terminal.usage?.inputTokens,
          outputTokens: terminal.usage?.outputTokens,
          totalTokens: terminal.usage?.totalTokens,
        }),
      )
    : terminal.status === 'interrupted'
      ? Effect.logWarning('turn.interrupted').pipe(
          Effect.annotateLogs({ threadId: thread.id, turnId: terminal.turnId }),
        )
      : Effect.logError('turn.failed').pipe(
          Effect.annotateLogs({ threadId: thread.id, turnId: terminal.turnId }),
        )

export const ChannelTurnsLive = Layer.effect(
  ChannelTurns,
  Effect.gen(function* () {
    const friday = yield* Friday
    const persistence = yield* ThreadPersistence
    const progress = yield* ChannelProgress
    const crypto = yield* Crypto.Crypto
    const semaphore = yield* PartitionedSemaphore.make<string>({ permits: 1 })

    const accept = Effect.fn('ChannelTurns.accept')(function* (request: AcceptChannelTurnRequest) {
      const accepted = yield* semaphore.withPermit(request.thread.id)(
        Effect.gen(function* () {
          const coordinator = yield* friday.openThread(request.thread)
          const latestTurn = yield* persistence.getLatestTurn(request.thread.id)
          const timestamp = yield* nowIso

          // Steering applies only to the same conversation's genuinely active
          // turn. A different conversation (parent vs routed thread) resolves
          // to a different thread id and never steers here.
          if (Option.isSome(latestTurn) && isActiveTurn(latestTurn.value)) {
            const sequence = latestTurn.value.activities.reduce(
              (highest, activity) => Math.max(highest, activity.sequence + 1),
              0,
            )
            const steering: SteeringActivityType = decodeSteeringActivity({
              id: decodeActivityId(yield* crypto.randomUUIDv4),
              sequence,
              status: 'completed',
              type: 'steering',
              message: request.message,
              createdAt: timestamp,
              updatedAt: timestamp,
              completedAt: timestamp,
            })
            const steered = yield* coordinator.steer(latestTurn.value.id, steering).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                isSteerRejected(error)
                  ? Effect.gen(function* () {
                      yield* Effect.logWarning('turn.steer-rejected').pipe(
                        Effect.annotateLogs({
                          threadId: request.thread.id,
                          turnId: latestTurn.value.id,
                        }),
                      )
                      return false
                    })
                  : Effect.fail(error),
              ),
            )
            if (steered) {
              yield* progress.accept(request.thread, request.message, latestTurn.value.id)
              yield* Effect.logInfo('turn.steered').pipe(
                Effect.annotateLogs({
                  threadId: request.thread.id,
                  turnId: latestTurn.value.id,
                  activityId: steering.id,
                }),
              )
              return Option.none<{
                readonly turnId: TurnType['id']
                readonly awaitTerminal: Effect.Effect<
                  TerminalTurn,
                  ThreadRuntimeError | ThreadPersistenceError
                >
              }>()
            }
            // Rejected steering falls through exactly once to a new turn so
            // terminal-window input is never lost nor duplicated.
          }

          const turn: TurnType = decodeTurn({
            id: decodeTurnId(yield* crypto.randomUUIDv4),
            threadId: request.thread.id,
            sequence: Option.match(latestTurn, {
              onNone: () => 1,
              onSome: (previous) => previous.sequence + 1,
            }),
            input: request.message,
            agentMessage: null,
            activities: [],
            model: request.thread.model,
            thinkingLevel: request.thread.thinkingLevel,
            harnessTurnId: null,
            status: 'pending',
            requestedAt: timestamp,
            startedAt: null,
            completedAt: null,
            errorMessage: null,
            usage: null,
          })
          const handle = yield* coordinator.prompt(turn)
          yield* progress.accept(request.thread, request.message, turn.id)
          yield* Effect.logInfo('turn.started').pipe(
            Effect.annotateLogs({
              threadId: request.thread.id,
              turnId: turn.id,
              turnSequence: turn.sequence,
              provider: turn.model.provider,
              modelId: turn.model.modelId,
              thinkingLevel: turn.thinkingLevel,
            }),
          )
          return Option.some({
            turnId: turn.id,
            awaitTerminal: handle.awaitTerminal,
          })
        }),
      )

      if (Option.isNone(accepted)) return

      const terminal = yield* accepted.value.awaitTerminal
      yield* logTerminal(request.thread, terminal)
      const text = Match.value(terminal).pipe(
        Match.when({ status: 'completed' }, ({ agentMessage }) => agentMessage),
        Match.when(
          { status: 'interrupted' },
          ({ agentMessage }) => agentMessage ?? 'Work was interrupted before a response was ready.',
        ),
        Match.when({ status: 'failed' }, ({ errorMessage }) => `Work failed: ${errorMessage}`),
        Match.exhaustive,
      )
      yield* progress.finalize(request.thread, accepted.value.turnId, text)
      yield* Effect.logInfo('publication.completed').pipe(
        Effect.annotateLogs({
          threadId: request.thread.id,
          turnId: terminal.turnId,
          responseLength: text.length,
        }),
      )
    })

    return ChannelTurns.of({ accept })
  }),
)
