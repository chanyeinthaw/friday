import type { DiscordAdapter } from '@chat-adapter/discord'
import type { Message } from 'chat'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { PlatformMessageId } from '@friday/contracts/conversation'
import type {
  PlatformMessageQuery,
  PlatformMessageRecord,
  PlatformMessageSearchResult,
} from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import { projectChatSdkContextMessage } from '../chat-sdk/MessageProjection.ts'
import { discordChannelConversationId, isDiscordThread } from './DiscordConversationScope.ts'

const MaximumScanCount = 500
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)

const targetThreadId = (
  discord: Pick<DiscordAdapter, 'decodeThreadId' | 'encodeThreadId'>,
  query: PlatformMessageQuery,
): string => {
  const location = discord.decodeThreadId(String(query.binding.conversationId))
  if (query.scope === 'thread' && isDiscordThread(location)) {
    return String(query.binding.conversationId)
  }
  return discordChannelConversationId(discord, location)
}

const recordFrom = (message: Message): PlatformMessageRecord => {
  const context = projectChatSdkContextMessage('discord', message)
  return {
    id: context.platformMessageId ?? decodeMessageId(message.id),
    author: context.author,
    text: context.content.text,
    sentAt: message.metadata.dateSent.toISOString(),
    replyToMessageId: message.replyTo ? decodeMessageId(message.replyTo.id) : null,
  }
}

export const searchDiscordMessages = Effect.fn('searchDiscordMessages')(function* (
  discord: Pick<DiscordAdapter, 'decodeThreadId' | 'encodeThreadId' | 'fetchMessages'>,
  query: PlatformMessageQuery,
) {
  const source = yield* Effect.try({
    try: () => targetThreadId(discord, query),
    catch: (cause) => new ChatSdkPublicationError({ operation: 'publish', cause }),
  })
  const matches: Array<PlatformMessageRecord> = []
  const needle = query.query?.trim().toLocaleLowerCase()
  let cursor = query.before === undefined ? undefined : String(query.before)
  let scannedCount = 0
  let hasMore = true

  while (matches.length < query.limit && scannedCount < MaximumScanCount && hasMore) {
    const remaining = Math.min(100, MaximumScanCount - scannedCount)
    const page = yield* Effect.tryPromise({
      try: () =>
        discord.fetchMessages(
          source,
          cursor === undefined ? { limit: remaining } : { limit: remaining, cursor },
        ),
      catch: (cause) => new ChatSdkPublicationError({ operation: 'publish', cause }),
    })
    scannedCount += page.messages.length
    for (const message of page.messages.toReversed()) {
      if (message.author.isBot || message.author.isMe) continue
      if (query.authorId !== undefined && message.author.userId !== query.authorId) continue
      if (needle !== undefined && !message.text.toLocaleLowerCase().includes(needle)) continue
      matches.push(recordFrom(message))
      if (matches.length >= query.limit) break
    }
    cursor = page.nextCursor
    hasMore = page.nextCursor !== undefined
  }

  return {
    messages: matches.toReversed(),
    scannedCount,
    truncated: hasMore || scannedCount >= MaximumScanCount,
  } satisfies PlatformMessageSearchResult
})
