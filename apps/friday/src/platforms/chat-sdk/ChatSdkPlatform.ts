import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'

import type { PlatformAdapter, PlatformPublication } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from './Errors.ts'

export interface ChatSdkPublicationSource {
  readonly thread: (threadId: string) => {
    readonly post: (text: string) => Promise<object>
    readonly startTyping: () => Promise<void>
  }
}

export interface ChatSdkPlatformOptions {
  readonly typingRefreshInterval?: Duration.Input
}

export const makeChatSdkPlatform = Effect.fn('makeChatSdkPlatform')(
  (
    kind: ConversationBinding['platform'],
    chat: ChatSdkPublicationSource,
    options: ChatSdkPlatformOptions = {},
  ): Effect.Effect<PlatformAdapter<ChatSdkPublicationError>> =>
    Effect.succeed({
      kind,
      publish: Effect.fn('ChatSdkPlatform.publish')((publication: PlatformPublication) =>
        Effect.tryPromise({
          try: () => chat.thread(String(publication.binding.conversationId)).post(publication.text),
          catch: (cause) =>
            new ChatSdkPublicationError({
              operation: 'publish',
              cause,
            }),
        }).pipe(Effect.asVoid),
      ),
      withTyping: Effect.fn('ChatSdkPlatform.withTyping')(function* <A, E, R>(
        binding: ConversationBinding,
        effect: Effect.Effect<A, E, R>,
      ) {
        const thread = chat.thread(String(binding.conversationId))
        const sendTyping = Effect.tryPromise({
          try: () => thread.startTyping(),
          catch: (cause) =>
            new ChatSdkPublicationError({
              operation: 'start-typing',
              cause,
            }),
        })
        const refreshInterval = options.typingRefreshInterval ?? Duration.millis(8000)
        // Refresh failures are absorbed by the loop itself: log a structured
        // warning, then end the refresh fiber successfully. The wrapped
        // effect and its publication continue, and no fallible detached child
        // is left with an unobserved error.
        const refreshLoop = Effect.forever(
          Effect.sleep(refreshInterval).pipe(Effect.andThen(sendTyping)),
        ).pipe(
          Effect.catchTag('ChatSdkPublicationError', (error) =>
            Effect.logWarning(
              'Chat SDK typing refresh failed; stopping typing refreshes',
              error,
            ).pipe(
              Effect.annotateLogs({
                threadId: String(binding.conversationId),
              }),
            ),
          ),
        )
        return yield* Effect.scoped(
          Effect.gen(function* () {
            // The immediate typing indicator is deliberately outside the
            // recovery: its failure still fails `withTyping` as
            // ChatSdkPublicationError and the wrapped effect never starts.
            yield* sendTyping
            yield* Effect.forkScoped(refreshLoop)
            return yield* effect
          }),
        )
      }),
    }),
)
