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
import { AppConfig } from '../config/AppConfigLive.ts'
import { TextGeneration } from '../harness/TextGeneration.ts'
import { ConversationTitles } from './ConversationTitles.ts'
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
  readonly hasBinding: (input: PlatformInput) => Effect.Effect<boolean, ThreadPersistenceError>
  readonly ingest: <CreationError, ContextError = never>(
    input: PlatformInput,
    createThread: (input: PlatformInput) => Effect.Effect<Thread, CreationError>,
    loadInitialContext?: (input: PlatformInput) => Effect.Effect<PlatformInput, ContextError>,
  ) => Effect.Effect<void, PlatformIngestionError<CreationError> | ContextError, Scope.Scope>
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
    const textGeneration = yield* TextGeneration
    const config = yield* AppConfig
    const conversationTitles = yield* ConversationTitles
    const semaphore = yield* PartitionedSemaphore.make<string>({ permits: 1 })

    return PlatformIngestion.of({
      hasBinding: (input) =>
        persistence
          .findPlatformThread({
            platform: input.binding.platform,
            connectionId: input.binding.connectionId,
            conversationId: input.binding.conversationId,
          })
          .pipe(Effect.map(Option.isSome)),
      ingest: (input, createThread, loadInitialContext) => {
        const key = `${input.binding.connectionId}:${input.binding.channelId}`
        const annotations = {
          component: 'ingestion',
          platform: input.binding.platform,
          connectionId: input.binding.connectionId,
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
                connectionId: input.binding.connectionId,
                conversationId: input.binding.conversationId,
              })
              const created = Option.isNone(foundThread)
              const enrichedInput =
                created && loadInitialContext !== undefined
                  ? yield* loadInitialContext(input)
                  : input
              const found = Option.isSome(foundThread)
                ? foundThread.value
                : yield* createThread(enrichedInput).pipe(
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
              if (created) {
                const currentModels = config.current().models
                yield* textGeneration
                  .generateThreadTitle({
                    message: input.message.content.text,
                    workingDirectory: found.workingDirectory,
                    model: currentModels.utility,
                    thinkingLevel: currentModels.utility.thinkingLevel,
                  })
                  .pipe(
                    Effect.flatMap((title) => conversationTitles.generated(found, title)),
                    Effect.matchEffect({
                      onFailure: (cause) =>
                        Effect.logWarning('conversation.title.failed').pipe(
                          Effect.annotateLogs({ threadId: found.id, cause: String(cause) }),
                        ),
                      onSuccess: () => Effect.void,
                    }),
                    Effect.forkDetach,
                    Effect.asVoid,
                  )
              }
              const message =
                created && enrichedInput.initialContext !== undefined
                  ? { ...enrichedInput.message, context: enrichedInput.initialContext }
                  : enrichedInput.message
              yield* channelTurns.accept({ thread: found, message })
            }),
          )
          .pipe(Effect.annotateLogs(annotations), Effect.withLogSpan('platform.ingest'))
      },
    })
  }),
)
