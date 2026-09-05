/* oxlint-disable eslint/no-underscore-dangle -- Effect schema errors use the canonical _tag discriminator. */

import type { ChannelThread, InputMessage, Thread, Turn } from '@friday/contracts/conversation'
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

type IngestCursor = {
  readonly created: boolean
  readonly afterMessageId?: string | undefined
}

export interface PlatformIngestionContract {
  readonly hasBinding: (input: PlatformInput) => Effect.Effect<boolean, ThreadPersistenceError>
  readonly ingest: <CreationError, ContextError = never>(
    input: PlatformInput,
    createThread: (input: PlatformInput) => Effect.Effect<Thread, CreationError>,
    loadContext?: (
      input: PlatformInput,
      cursor: IngestCursor,
    ) => Effect.Effect<PlatformInput, ContextError>,
  ) => Effect.Effect<void, PlatformIngestionError<CreationError> | ContextError, Scope.Scope>
}

export class PlatformIngestion extends Context.Service<
  PlatformIngestion,
  PlatformIngestionContract
>()('friday/platforms/PlatformIngestion') {}

const ingestKey = (input: PlatformInput): string =>
  `${input.binding.connectionId}:${input.binding.channelId}`

const ingestAnnotations = (input: PlatformInput) => ({
  component: 'ingestion' as const,
  platform: input.binding.platform,
  connectionId: input.binding.connectionId,
  channelId: input.binding.channelId,
  conversationId: input.binding.conversationId,
  platformMessageId: input.message.platformMessageId,
  messageLength: input.message.content.text.length,
  imageCount: input.message.content.images.length,
})

const afterMessageIdFromTurn = (latestUserTurn: Option.Option<Turn>): string | undefined =>
  Option.flatMap(latestUserTurn, (turn) => Option.fromNullishOr(turn.input.platformMessageId)).pipe(
    Option.getOrUndefined,
  )

const resolveIngestMessage = (enrichedInput: PlatformInput): InputMessage =>
  enrichedInput.initialContext !== undefined && enrichedInput.initialContext.length > 0
    ? { ...enrichedInput.message, context: enrichedInput.initialContext }
    : enrichedInput.message

export const PlatformIngestionLive = Layer.effect(
  PlatformIngestion,
  Effect.gen(function* () {
    const persistence = yield* ThreadPersistence
    const channelTurns = yield* ChannelTurns
    const textGeneration = yield* TextGeneration
    const config = yield* AppConfig
    const conversationTitles = yield* ConversationTitles
    const semaphore = yield* PartitionedSemaphore.make<string>({ permits: 1 })

    const lookupAdmission = Effect.fn('PlatformIngestion.lookupAdmission')(function* (
      input: PlatformInput,
    ) {
      return yield* persistence.findPlatformThread({
        platform: input.binding.platform,
        connectionId: input.binding.connectionId,
        conversationId: input.binding.conversationId,
      })
    })

    const enrichWithContext = Effect.fn('PlatformIngestion.enrichWithContext')(function* <
      ContextError,
    >(
      input: PlatformInput,
      foundThread: Option.Option<Thread>,
      loadContext?: (
        input: PlatformInput,
        cursor: IngestCursor,
      ) => Effect.Effect<PlatformInput, ContextError>,
    ) {
      const created = Option.isNone(foundThread)
      const latestUserTurn =
        Option.isSome(foundThread) && loadContext !== undefined
          ? yield* persistence.getLatestUserTurn(foundThread.value.id)
          : Option.none()
      const afterMessageId = afterMessageIdFromTurn(latestUserTurn)
      if (loadContext === undefined) return { enrichedInput: input, created }
      const enrichedInput = yield* loadContext(input, { created, afterMessageId })
      return { enrichedInput, created }
    })

    const resolveChannelThread = Effect.fn('PlatformIngestion.resolveChannelThread')(function* <
      CreationError,
    >(
      foundThread: Option.Option<Thread>,
      enrichedInput: PlatformInput,
      createThread: (input: PlatformInput) => Effect.Effect<Thread, CreationError>,
    ) {
      const found = Option.isSome(foundThread)
        ? foundThread.value
        : yield* createThread(enrichedInput).pipe(
            Effect.tap((thread) => persistence.createThread(thread)),
            Effect.tap((thread) =>
              Effect.logInfo('thread.created').pipe(Effect.annotateLogs({ threadId: thread.id })),
            ),
          )
      if (Option.isSome(foundThread)) {
        yield* Effect.logDebug('thread.resolved').pipe(Effect.annotateLogs({ threadId: found.id }))
      }
      if (found.audience !== 'user') return yield* Effect.die('Expected channel Thread')
      return found
    })

    const launchTitleSidecar = Effect.fn('PlatformIngestion.launchTitleSidecar')(function* (
      thread: ChannelThread,
      sourceText: string,
    ) {
      const currentModels = config.current().models
      yield* Effect.gen(function* () {
        const title = yield* textGeneration.generateThreadTitle({
          message: sourceText,
          workingDirectory: thread.workingDirectory,
          model: currentModels.utility,
          thinkingLevel: currentModels.utility.thinkingLevel,
        })
        yield* conversationTitles.generated(thread, title)
      }).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.logWarning('conversation.title.failed').pipe(
              Effect.annotateLogs({ threadId: thread.id, cause: String(cause) }),
            ),
          onSuccess: () => Effect.void,
        }),
        Effect.forkDetach,
        Effect.asVoid,
      )
    })

    const ingest = Effect.fn('PlatformIngestion.ingest')(function* <
      CreationError,
      ContextError = never,
    >(
      input: PlatformInput,
      createThread: (input: PlatformInput) => Effect.Effect<Thread, CreationError>,
      loadContext?: (
        input: PlatformInput,
        cursor: IngestCursor,
      ) => Effect.Effect<PlatformInput, ContextError>,
    ) {
      const key = ingestKey(input)
      const annotations = ingestAnnotations(input)
      return yield* semaphore
        .withPermit(key)(
          Effect.gen(function* () {
            const foundThread = yield* lookupAdmission(input)
            const { enrichedInput, created } = yield* enrichWithContext(
              input,
              foundThread,
              loadContext,
            )
            const thread = yield* resolveChannelThread(foundThread, enrichedInput, createThread)
            if (created) {
              yield* launchTitleSidecar(thread, input.message.content.text)
            }
            const message = resolveIngestMessage(enrichedInput)
            yield* channelTurns.accept({ thread, message })
          }),
        )
        .pipe(Effect.annotateLogs(annotations), Effect.withLogSpan('platform.ingest'))
    })

    return PlatformIngestion.of({
      hasBinding: (input) =>
        persistence
          .findPlatformThread({
            platform: input.binding.platform,
            connectionId: input.binding.connectionId,
            conversationId: input.binding.conversationId,
          })
          .pipe(Effect.map(Option.isSome)),
      ingest,
    })
  }),
)
