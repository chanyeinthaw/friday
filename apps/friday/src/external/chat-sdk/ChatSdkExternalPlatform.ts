import * as Effect from 'effect/Effect'

import type { ExternalPlatformContract, ExternalPublication } from '../ExternalPlatform.ts'
import { ChatSdkPublicationError } from './Errors.ts'

export interface ChatSdkPublicationSource {
  readonly thread: (threadId: string) => {
    readonly post: (text: string) => Promise<object>
  }
}

export const makeChatSdkExternalPlatform = Effect.fn('makeChatSdkExternalPlatform')(
  (chat: ChatSdkPublicationSource) =>
    Effect.succeed({
      publish: Effect.fn('ChatSdkExternalPlatform.publish')((publication: ExternalPublication) =>
        Effect.tryPromise({
          try: () =>
            chat.thread(String(publication.binding.externalThreadId)).post(publication.text),
          catch: (cause) =>
            new ChatSdkPublicationError({
              operation: 'publish',
              cause,
            }),
        }).pipe(Effect.asVoid),
      ),
    } satisfies ExternalPlatformContract<ChatSdkPublicationError>),
)
