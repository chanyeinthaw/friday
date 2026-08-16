/* oxlint-disable eslint/no-underscore-dangle -- Effect schema errors use the canonical _tag discriminator. */

import {
  ActivityId,
  SteeringActivity,
  Turn,
  TurnId,
  type ChannelThread,
  type SteeringActivity as SteeringActivityType,
  type Thread,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import * as PartitionedSemaphore from 'effect/PartitionedSemaphore'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { FridayApplicationContract } from '../FridayApplication.ts'
import type { ThreadCoordinatorContract } from '../conversation/ThreadCoordinator.ts'
import {
  ThreadPersistence,
  type ThreadPersistenceError,
} from '../conversation/ThreadPersistence.ts'
import type { ExternalInboundMessage, ExternalPlatformContract } from './ExternalPlatform.ts'

const decodeTurn = Schema.decodeUnknownSync(Turn)
const decodeSteeringActivity = Schema.decodeUnknownSync(SteeringActivity)
const decodeTurnId = Schema.decodeUnknownSync(TurnId)
const decodeActivityId = Schema.decodeUnknownSync(ActivityId)
const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

export class ExternalThreadNotFoundError extends Schema.Error<ExternalThreadNotFoundError>(
  'ExternalThreadNotFoundError',
)({
  _tag: Schema.tag('ExternalThreadNotFoundError'),
  platform: Schema.String,
  channelId: Schema.String,
}) {
  override get message(): string {
    return `No Friday channel Thread exists for ${this.platform}:${this.channelId}`
  }
}

export interface ExternalIngestionContract<PromptError, PublicationError> {
  readonly ingest: (
    inbound: ExternalInboundMessage,
  ) => Effect.Effect<
    void,
    | PromptError
    | ThreadPersistenceError
    | ExternalThreadNotFoundError
    | PlatformError.PlatformError
    | PublicationError,
    Scope.Scope
  >
}

const isActiveTurn = (turn: TurnType): boolean =>
  turn.status === 'pending' || turn.status === 'running'

export const makeExternalIngestion = Effect.fn('makeExternalIngestion')(function* <
  PromptError,
  EventError,
  PublicationError,
>(
  application: FridayApplicationContract<PromptError, EventError>,
  externalPlatform: ExternalPlatformContract<PublicationError>,
) {
  const persistence = yield* ThreadPersistence
  const crypto = yield* Crypto.Crypto
  const semaphore = yield* PartitionedSemaphore.make<string>({ permits: Number.POSITIVE_INFINITY })
  const coordinators = new Map<Thread['id'], ThreadCoordinatorContract<PromptError, EventError>>()

  const awaitTerminalTurn = Effect.fn('ExternalIngestion.awaitTerminalTurn')(function* (
    turnId: TurnType['id'],
  ) {
    while (true) {
      const stored = yield* persistence.getTurn(turnId)
      if (Option.isSome(stored) && !isActiveTurn(stored.value)) return stored.value
      yield* Effect.sleep('50 millis')
    }
  })

  const coordinatorFor = Effect.fn('ExternalIngestion.coordinatorFor')(function* (thread: Thread) {
    const existing = coordinators.get(thread.id)
    if (existing) return existing
    const coordinator = yield* application.openThread(thread)
    coordinators.set(thread.id, coordinator)
    return coordinator
  })

  return {
    ingest: (inbound) => {
      const key = `${inbound.binding.platform}:${inbound.binding.channelId}`
      const accepted = semaphore.withPermit(key)(
        Effect.gen(function* () {
          const foundThread = yield* persistence.findChannelThread({
            platform: inbound.binding.platform,
            channelId: inbound.binding.channelId,
          })
          if (Option.isNone(foundThread)) {
            return yield* new ExternalThreadNotFoundError({
              platform: inbound.binding.platform,
              channelId: inbound.binding.channelId,
            })
          }

          const found = foundThread.value
          if (found.audience !== 'user') return yield* Effect.die('Expected channel Thread')
          const thread = found
          const coordinator = yield* coordinatorFor(thread)
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
              message: inbound.message,
              createdAt: timestamp,
              updatedAt: timestamp,
              completedAt: timestamp,
            })
            yield* coordinator.steer(latestTurn.value.id, steering)
            return Option.none<{
              readonly turnId: TurnType['id']
              readonly thread: ChannelThread
            }>()
          }

          const turn: TurnType = decodeTurn({
            id: decodeTurnId(yield* crypto.randomUUIDv4),
            threadId: thread.id,
            sequence: Option.match(latestTurn, {
              onNone: () => 1,
              onSome: (previous) => previous.sequence + 1,
            }),
            input: inbound.message,
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
          yield* coordinator.prompt(turn)
          return Option.some({ turnId: turn.id, thread })
        }),
      )
      return accepted.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: ({ turnId, thread }) =>
              awaitTerminalTurn(turnId).pipe(
                Effect.flatMap((completed) =>
                  completed.status === 'completed' && completed.agentMessage !== null
                    ? externalPlatform.publish({
                        binding: thread.externalBinding,
                        text: completed.agentMessage,
                      })
                    : Effect.void,
                ),
              ),
          }),
        ),
      )
    },
  } satisfies ExternalIngestionContract<PromptError, PublicationError>
})
