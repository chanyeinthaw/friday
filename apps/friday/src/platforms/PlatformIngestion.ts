/* oxlint-disable eslint/no-underscore-dangle -- Effect schema errors use the canonical _tag discriminator. */

import type { Thread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as PlatformError from 'effect/PlatformError'
import * as PartitionedSemaphore from 'effect/PartitionedSemaphore'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import { ChannelTurns, type ChannelTurnError } from '../conversation/ChannelTurns.ts'
import {
  ThreadPersistence,
  type ThreadPersistenceError,
} from '../conversation/ThreadPersistence.ts'
import type { PlatformInput } from './PlatformAdapter.ts'
import { PlatformNotFoundError, PlatformOperationError } from './PlatformRegistry.ts'

export class PlatformThreadNotFoundError extends Schema.Error<PlatformThreadNotFoundError>(
  'PlatformThreadNotFoundError',
)({
  _tag: Schema.tag('PlatformThreadNotFoundError'),
  platform: Schema.String,
  channelId: Schema.String,
}) {
  override get message(): string {
    return `No Friday channel Thread exists for ${this.platform}:${this.channelId}`
  }
}

export type PlatformIngestionError<CreationError> =
  | ChannelTurnError
  | ThreadPersistenceError
  | PlatformThreadNotFoundError
  | PlatformError.PlatformError
  | PlatformNotFoundError
  | PlatformOperationError
  | CreationError

export interface PlatformIngestionContract {
  readonly ingest: <CreationError>(
    input: PlatformInput,
    createThread: (input: PlatformInput) => Effect.Effect<Thread, CreationError>,
  ) => Effect.Effect<void, PlatformIngestionError<CreationError>, Scope.Scope>
}

export class PlatformIngestion extends Context.Service<
  PlatformIngestion,
  PlatformIngestionContract
>()('friday/platforms/PlatformIngestion') {}

export const PlatformIngestionLive = Layer.effect(
  PlatformIngestion,
  Effect.gen(function* () {
    const persistence = yield* ThreadPersistence
    const channelTurns = yield* ChannelTurns
    const semaphore = yield* PartitionedSemaphore.make<string>({ permits: 1 })

    return PlatformIngestion.of({
      ingest: (input, createThread) => {
        const key = `${input.binding.platform}:${input.binding.channelId}`
        const annotations = {
          component: 'ingestion',
          platform: input.binding.platform,
          channelId: input.binding.channelId,
          conversationId: input.binding.conversationId,
          platformMessageId: input.message.platformMessageId,
          messageLength: input.message.content.text.length,
          imageCount: input.message.content.images.length,
        }
        return semaphore
          .withPermit(key)(
            Effect.gen(function* () {
              const foundThread = yield* persistence.findPlatformThread({
                platform: input.binding.platform,
                conversationId: input.binding.conversationId,
              })
              const found = Option.isSome(foundThread)
                ? foundThread.value
                : yield* createThread(input).pipe(
                    Effect.tap((thread) => persistence.createThread(thread)),
                    Effect.tap((thread) =>
                      Effect.logInfo('thread.created').pipe(
                        Effect.annotateLogs({ threadId: thread.id }),
                      ),
                    ),
                  )
              if (Option.isSome(foundThread)) {
                yield* Effect.logDebug('thread.resolved').pipe(
                  Effect.annotateLogs({ threadId: found.id }),
                )
              }
              if (found.audience !== 'user') return yield* Effect.die('Expected channel Thread')
              yield* channelTurns.accept({ thread: found, message: input.message })
            }),
          )
          .pipe(Effect.annotateLogs(annotations), Effect.withLogSpan('platform.ingest'))
      },
    })
  }),
)
