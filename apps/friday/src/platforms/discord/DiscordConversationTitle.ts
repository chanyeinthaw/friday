import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'

import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import { isDiscordThread } from './DiscordConversationScope.ts'
import type { PlatformConversationTitle } from '../PlatformAdapter.ts'

export const setDiscordConversationTitle = (
  discord: Pick<DiscordAdapter, 'decodeThreadId' | 'setThreadTitle'>,
  input: PlatformConversationTitle,
): Effect.Effect<void, ChatSdkPublicationError> =>
  Effect.gen(function* () {
    const conversationId = String(input.binding.conversationId)
    const location = yield* Effect.try({
      try: () => discord.decodeThreadId(conversationId),
      catch: (cause) => new ChatSdkPublicationError({ operation: 'set-conversation-title', cause }),
    })
    if (!isDiscordThread(location)) return
    yield* Effect.tryPromise({
      try: () => discord.setThreadTitle(conversationId, input.title),
      catch: (cause) => new ChatSdkPublicationError({ operation: 'set-conversation-title', cause }),
    })
  })
