import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'

import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import type { PlatformConversationTitle } from '../PlatformAdapter.ts'

export const setDiscordConversationTitle = (
  discord: DiscordAdapter,
  input: PlatformConversationTitle,
): Effect.Effect<void, ChatSdkPublicationError> =>
  Effect.tryPromise({
    try: () => discord.setThreadTitle(String(input.binding.conversationId), input.title),
    catch: (cause) => new ChatSdkPublicationError({ operation: 'set-conversation-title', cause }),
  })
