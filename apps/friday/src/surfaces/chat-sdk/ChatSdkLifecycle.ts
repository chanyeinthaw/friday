import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'

import type { SurfaceInput } from '../Surface.ts'
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
  readonly thread: (threadId: string) => {
    readonly post: (text: string) => Promise<object>
  }
  readonly onNewMention: (handler: ChatSdkMessageHandler) => void
  readonly onDirectMessage: (handler: ChatSdkMessageHandler) => void
  readonly onSubscribedMessage: (handler: ChatSdkMessageHandler) => void
}

export interface ChatSdkLifecycleContract {
  readonly chat: ChatSdkLifecycleSource
}

export interface MakeChatSdkLifecycleOptions<InboundError, InboundServices> {
  readonly chat: ChatSdkLifecycleSource
  readonly onInboundMessage: (
    message: SurfaceInput,
  ) => Effect.Effect<void, InboundError, InboundServices>
}

export const makeChatSdkLifecycle = Effect.fn('makeChatSdkLifecycle')(function* <
  InboundError,
  InboundServices,
>(
  options: MakeChatSdkLifecycleOptions<InboundError, InboundServices>,
): Effect.fn.Return<
  ChatSdkLifecycleContract,
  ChatSdkLifecycleError,
  Scope.Scope | InboundServices
> {
  const effectContext = yield* Effect.context<InboundServices>()
  const lifecycleScope = yield* Effect.scope
  const runPromise = Effect.runPromiseWith(effectContext)
  // Each inbound callback forks its ingestion worker into the lifecycle scope
  // and joins it: the Promise returned to the Chat SDK still reflects
  // completion/failure, but the worker fiber is owned by the scope, so closing
  // the lifecycle interrupts any ingestion still in flight instead of letting
  // it keep running (and refreshing typing) past shutdown.
  const handleMessage: ChatSdkMessageHandler = (thread, message) =>
    runPromise(
      Effect.gen(function* () {
        const worker = yield* options.onInboundMessage(projectChatSdkMessage(thread, message)).pipe(
          Effect.tapError((cause) => Effect.logError('Friday inbound message failed', cause)),
          Effect.mapError(
            (cause) =>
              new ChatSdkCallbackError({
                operation: 'inbound-message',
                cause,
              }),
          ),
          Effect.forkIn(lifecycleScope),
        )
        return yield* Fiber.join(worker)
      }),
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
