import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import type * as Scope from 'effect/Scope'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { ChatSdkCallbackError, ChatSdkLifecycleError } from './Errors.ts'
import {
  projectChatSdkMessage,
  type ChatSdkMessageProjectionSource,
  type ChatSdkThreadProjectionSource,
} from './MessageProjection.ts'

export type ChatSdkMessageHandler = (
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

export interface ChatSdkLifecycleOptions<InboundError, InboundServices> {
  readonly chat: ChatSdkLifecycleSource
  readonly normalizeInboundMessage?: (
    thread: ChatSdkThreadProjectionSource,
    message: ChatSdkMessageProjectionSource,
  ) => Effect.Effect<PlatformInput, ChatSdkCallbackError>
  readonly shouldHandleMessage?: (
    thread: ChatSdkThreadProjectionSource,
    message: ChatSdkMessageProjectionSource,
  ) => Effect.Effect<boolean, ChatSdkCallbackError>
  readonly onInboundMessage: (
    message: PlatformInput,
  ) => Effect.Effect<void, InboundError, InboundServices>
}

interface ChatSdkMessageHandlerOptions<InboundError, InboundServices> {
  readonly context: Context.Context<InboundServices>
  readonly scope: Scope.Scope
  readonly normalizeInboundMessage?: ChatSdkLifecycleOptions<
    InboundError,
    InboundServices
  >['normalizeInboundMessage']
  readonly shouldHandleMessage?: ChatSdkLifecycleOptions<
    InboundError,
    InboundServices
  >['shouldHandleMessage']
  readonly onInboundMessage: ChatSdkLifecycleOptions<
    InboundError,
    InboundServices
  >['onInboundMessage']
}

const callbackError = (cause: unknown): ChatSdkCallbackError =>
  new ChatSdkCallbackError({
    operation: 'inbound-message',
    cause,
  })

const makeChatSdkMessageHandler = <InboundError, InboundServices>(
  options: ChatSdkMessageHandlerOptions<InboundError, InboundServices>,
): ChatSdkMessageHandler => {
  const runPromise = Effect.runPromiseWith(options.context)

  const handleInboundMessage = (
    thread: ChatSdkThreadProjectionSource,
    message: ChatSdkMessageProjectionSource,
  ): Effect.Effect<void, ChatSdkCallbackError, InboundServices> =>
    Effect.gen(function* () {
      const shouldHandle = options.shouldHandleMessage
        ? yield* options.shouldHandleMessage(thread, message)
        : true
      if (!shouldHandle) return yield* Effect.void

      const input = options.normalizeInboundMessage
        ? yield* options.normalizeInboundMessage(thread, message)
        : yield* Effect.try({
            try: () => projectChatSdkMessage(thread, message),
            catch: callbackError,
          })
      yield* Effect.logInfo('platform.message.accepted').pipe(
        Effect.annotateLogs({
          component: 'chat-sdk',
          platform: input.binding.platform,
          channelId: input.binding.channelId,
          conversationId: input.binding.conversationId,
          platformMessageId: input.message.platformMessageId,
          messageLength: input.message.content.text.length,
        }),
      )
      const worker = yield* options
        .onInboundMessage(input)
        .pipe(Effect.mapError(callbackError), Effect.forkIn(options.scope))
      return yield* Fiber.join(worker)
    }).pipe(Effect.tapError((cause) => Effect.logError('Friday Chat SDK callback failed', cause)))

  return (thread, message) => runPromise(handleInboundMessage(thread, message))
}

const registerChatSdkHandlers = (
  chat: ChatSdkLifecycleSource,
  handler: ChatSdkMessageHandler,
): Effect.Effect<void, ChatSdkLifecycleError> =>
  Effect.try({
    try: () => {
      chat.onNewMention(handler)
      chat.onDirectMessage(handler)
      chat.onSubscribedMessage(handler)
    },
    catch: (cause) =>
      new ChatSdkLifecycleError({
        operation: 'register-handlers',
        cause,
      }),
  })

const initializeChatSdk = (
  chat: ChatSdkLifecycleSource,
): Effect.Effect<void, ChatSdkLifecycleError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => chat.initialize(),
      catch: (cause) =>
        new ChatSdkLifecycleError({
          operation: 'initialize',
          cause,
        }),
    }),
    () =>
      Effect.tryPromise({
        try: () => chat.shutdown(),
        catch: (cause) =>
          new ChatSdkLifecycleError({
            operation: 'shutdown',
            cause,
          }),
      }).pipe(Effect.orDie),
  )

export type ChatSdkLifecycleStart<InboundServices> = Effect.fn.Return<
  void,
  ChatSdkLifecycleError,
  Scope.Scope | InboundServices
>

export const startChatSdkLifecycle = Effect.fn('startChatSdkLifecycle')(function* <
  InboundError,
  InboundServices,
>(
  options: ChatSdkLifecycleOptions<InboundError, InboundServices>,
): ChatSdkLifecycleStart<InboundServices> {
  const handler = makeChatSdkMessageHandler({
    context: yield* Effect.context<InboundServices>(),
    scope: yield* Effect.scope,
    normalizeInboundMessage: options.normalizeInboundMessage,
    shouldHandleMessage: options.shouldHandleMessage,
    onInboundMessage: options.onInboundMessage,
  })

  yield* registerChatSdkHandlers(options.chat, handler)
  yield* initializeChatSdk(options.chat)
})
