import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ExternalInboundMessage } from '../ExternalPlatform.ts'
import { ChatSdkCallbackError, ChatSdkLifecycleError } from './Errors.ts'
import {
  projectChatSdkMessage,
  type ChatSdkMessageProjectionSource,
  type ChatSdkThreadProjectionSource,
} from './MessageProjection.ts'

type ChatSdkMessageHandler = (
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
) => Promise<void>

export interface ChatSdkLifecycleSource {
  readonly initialize: () => Promise<void>
  readonly shutdown: () => Promise<void>
  readonly onNewMention: (handler: ChatSdkMessageHandler) => void
  readonly onDirectMessage: (handler: ChatSdkMessageHandler) => void
  readonly onSubscribedMessage: (handler: ChatSdkMessageHandler) => void
}

export interface ChatSdkLifecycleContract {
  readonly chat: ChatSdkLifecycleSource
}

export interface MakeChatSdkLifecycleOptions<InboundError> {
  readonly chat: ChatSdkLifecycleSource
  readonly onInboundMessage: (message: ExternalInboundMessage) => Effect.Effect<void, InboundError>
}

export const makeChatSdkLifecycle = Effect.fn('makeChatSdkLifecycle')(function* <InboundError>(
  options: MakeChatSdkLifecycleOptions<InboundError>,
): Effect.fn.Return<ChatSdkLifecycleContract, ChatSdkLifecycleError, Scope.Scope> {
  const effectContext = yield* Effect.context()
  const runPromise = Effect.runPromiseWith(effectContext)
  const handleMessage: ChatSdkMessageHandler = (thread, message) =>
    runPromise(
      options.onInboundMessage(projectChatSdkMessage(thread, message)).pipe(
        Effect.mapError(
          (cause) =>
            new ChatSdkCallbackError({
              operation: 'inbound-message',
              cause,
            }),
        ),
      ),
    )

  options.chat.onNewMention(handleMessage)
  options.chat.onDirectMessage(handleMessage)
  options.chat.onSubscribedMessage(handleMessage)

  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => options.chat.initialize(),
      catch: (cause) =>
        new ChatSdkLifecycleError({
          operation: 'initialize',
          cause,
        }),
    }),
    () =>
      Effect.tryPromise({
        try: () => options.chat.shutdown(),
        catch: (cause) =>
          new ChatSdkLifecycleError({
            operation: 'shutdown',
            cause,
          }),
      }).pipe(Effect.orDie),
  )

  return { chat: options.chat }
})
