import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'

import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import type { PlatformConversationTitle } from '../PlatformAdapter.ts'

export const setDiscordConversationTitle = (
  discord: DiscordAdapter,
  botToken: string,
  input: PlatformConversationTitle,
): Effect.Effect<void, ChatSdkPublicationError> =>
  Effect.tryPromise({
    try: async () => {
      const location = discord.decodeThreadId(String(input.binding.conversationId))
      if (!location.threadId) return
      const response = await fetch(`https://discord.com/api/v10/channels/${location.threadId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: input.title.slice(0, 100) }),
      })
      if (!response.ok) throw new Error(`Discord thread rename failed: HTTP ${response.status}`)
    },
    catch: (cause) => new ChatSdkPublicationError({ operation: 'set-conversation-title', cause }),
  })
