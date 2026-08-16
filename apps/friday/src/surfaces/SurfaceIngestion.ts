/* oxlint-disable eslint/no-underscore-dangle -- Effect schema errors use the canonical _tag discriminator. */

import {
  ActivityId,
  SteeringActivity,
  Turn,
  TurnId,
  type ExternalBinding,
  type SteeringActivity as SteeringActivityType,
  type Thread,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import * as PartitionedSemaphore from 'effect/PartitionedSemaphore'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import { Friday } from '../Friday.ts'
import type { TerminalTurn } from '../conversation/ThreadCoordinator.ts'
import type { ThreadRuntimeError } from '../conversation/ThreadRuntimes.ts'
import {
  ThreadPersistence,
  type ThreadPersistenceError,
} from '../conversation/ThreadPersistence.ts'
import type { SurfaceInput } from './Surface.ts'
import { SurfaceNotFoundError, SurfaceOperationError, Surfaces } from './Surfaces.ts'

const decodeTurn = Schema.decodeUnknownSync(Turn)
const decodeSteeringActivity = Schema.decodeUnknownSync(SteeringActivity)
const decodeTurnId = Schema.decodeUnknownSync(TurnId)
const decodeActivityId = Schema.decodeUnknownSync(ActivityId)
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

export class SurfaceThreadNotFoundError extends Schema.Error<SurfaceThreadNotFoundError>(
  'SurfaceThreadNotFoundError',
)({
  _tag: Schema.tag('SurfaceThreadNotFoundError'),
  surface: Schema.String,
  channelId: Schema.String,
}) {
  override get message(): string {
    return `No Friday channel Thread exists for ${this.surface}:${this.channelId}`
  }
}

export type SurfaceIngestionError<CreationError> =
  | ThreadRuntimeError
  | ThreadPersistenceError
  | SurfaceThreadNotFoundError
  | PlatformError.PlatformError
  | SurfaceNotFoundError
  | SurfaceOperationError
  | CreationError

export interface SurfaceIngestionContract {
  readonly ingest: <CreationError>(
    input: SurfaceInput,
    createThread: (input: SurfaceInput) => Effect.Effect<Thread, CreationError>,
  ) => Effect.Effect<void, SurfaceIngestionError<CreationError>, Scope.Scope>
}

export class SurfaceIngestion extends Context.Service<SurfaceIngestion, SurfaceIngestionContract>()(
  'friday/surfaces/SurfaceIngestion',
) {}

const isActiveTurn = (turn: TurnType): boolean =>
  turn.status === 'pending' || turn.status === 'running'

export const SurfaceIngestionLive = Layer.effect(
  SurfaceIngestion,
  Effect.gen(function* () {
    const friday = yield* Friday
    const persistence = yield* ThreadPersistence
    const surfaces = yield* Surfaces
    const crypto = yield* Crypto.Crypto
    const semaphore = yield* PartitionedSemaphore.make<string>({ permits: 1 })

    return SurfaceIngestion.of({
      ingest: (input, createThread) => {
        const key = `${input.binding.platform}:${input.binding.channelId}`
        const accepted = semaphore.withPermit(key)(
          Effect.gen(function* () {
            const foundThread = yield* persistence.findExternalThread({
              platform: input.binding.platform,
              externalThreadId: input.binding.externalThreadId,
            })
            const found = Option.isSome(foundThread)
              ? foundThread.value
              : yield* createThread(input).pipe(
                  Effect.tap((thread) => persistence.createThread(thread)),
                )
            if (found.audience !== 'user') return yield* Effect.die('Expected channel Thread')
            const thread = found
            const coordinator = yield* friday.openThread(thread)
            const latestTurn = yield* persistence.getLatestTurn(thread.id)
            const timestamp = yield* nowIso

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
                message: input.message,
                createdAt: timestamp,
                updatedAt: timestamp,
                completedAt: timestamp,
              })
              yield* coordinator.steer(latestTurn.value.id, steering)
              return Option.none<{
                readonly awaitTerminal: Effect.Effect<
                  TerminalTurn,
                  ThreadRuntimeError | ThreadPersistenceError
                >
                readonly publicationBinding: ExternalBinding
              }>()
            }

            const turn: TurnType = decodeTurn({
              id: decodeTurnId(yield* crypto.randomUUIDv4),
              threadId: thread.id,
              sequence: Option.match(latestTurn, {
                onNone: () => 1,
                onSome: (previous) => previous.sequence + 1,
              }),
              input: input.message,
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
            })
            const handle = yield* coordinator.prompt(turn)
            return Option.some({
              awaitTerminal: handle.awaitTerminal,
              publicationBinding: input.binding,
            })
          }),
        )
        return accepted.pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: ({ awaitTerminal, publicationBinding }) =>
                surfaces.withTyping(
                  publicationBinding,
                  awaitTerminal.pipe(
                    Effect.flatMap((terminal) =>
                      terminal.status === 'completed'
                        ? surfaces.publish({
                            binding: publicationBinding,
                            text: terminal.agentMessage,
                          })
                        : Effect.void,
                    ),
                  ),
                ),
            }),
          ),
        )
      },
    })
  }),
)
