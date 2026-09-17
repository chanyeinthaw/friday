import type { DiscordAdapter } from '@chat-adapter/discord'
import type { Message } from 'chat'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { PlatformMessageId } from '@friday/contracts/conversation'
import {
  PlatformMessageNotFoundError,
  type PlatformMessageGetQuery,
  type PlatformMessageGetResult,
  type PlatformMessageQuery,
  type PlatformMessageRecord,
  type PlatformMessageSearchResult,
} from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import { projectChatSdkContextMessage } from '../chat-sdk/MessageProjection.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'
import { discordChannelConversationId, isDiscordThread } from './DiscordConversationScope.ts'

const MaximumScanCount = 500
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeMessageIdOption = Schema.decodeUnknownOption(PlatformMessageId)

const targetThreadId = (
  discord: Pick<DiscordAdapter, 'decodeThreadId' | 'encodeThreadId'>,
  query: Pick<PlatformMessageQuery, 'binding' | 'scope'>,
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

/** Transport needed for direct single-message retrieval. */
export interface DiscordMessageGetAdapter extends Pick<
  DiscordAdapter,
  'decodeThreadId' | 'encodeThreadId' | 'fetchChannelInfo'
> {
  readonly fetchDirectMessage: (channelId: string, messageId: string) => Promise<Message>
}

export interface DiscordMessageGetPolicy {
  readonly resolveChannelPolicy: (
    guildId: string,
    channelId: string,
  ) => DiscordResolvedChannelPolicy | undefined
}

const DiscordThreadChannel = Schema.Struct({
  id: Schema.String,
  parent_id: Schema.String,
  type: Schema.Literals([10, 11, 12]),
})
const decodeDiscordThreadChannel = Schema.decodeUnknownOption(DiscordThreadChannel)

const messageNotFound = (messageId: string) =>
  new PlatformMessageNotFoundError({ kind: 'discord', messageId })

interface DiscordMessageUrl {
  readonly guildId: string
  readonly channelId: string
  readonly messageId: string
}

const parseDiscordMessageUrl = (
  rawUrl: string,
): Effect.Effect<DiscordMessageUrl, PlatformMessageNotFoundError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(rawUrl.trim()),
      catch: () => messageNotFound(rawUrl.trim()),
    })
    const host = url.hostname.toLocaleLowerCase()
    if (!host.endsWith('discord.com') && !host.endsWith('discordapp.com')) {
      return yield* messageNotFound(rawUrl.trim())
    }
    const segments = url.pathname.split('/')
    if (
      segments.length !== 5 ||
      segments[1] !== 'channels' ||
      segments[2] === undefined ||
      segments[2] === '' ||
      segments[3] === undefined ||
      segments[3] === '' ||
      segments[4] === undefined ||
      segments[4] === ''
    ) {
      return yield* messageNotFound(rawUrl.trim())
    }
    return { guildId: segments[2], channelId: segments[3], messageId: segments[4] }
  })

/**
 * Fetches one Discord message through the direct single-message endpoint.
 * A bare message id resolves against the selected conversation scope (thread
 * or parent channel); a message URL must stay on the same connection (enforced
 * by registry routing), the same guild, and an admitted channel, with thread
 * URLs inheriting their parent channel policy. Direct messages (`@me`) are
 * rejected. Inaccessible and missing targets collapse to a generic not-found,
 * and bot authors are preserved (unlike history search, which skips bots).
 */
export const getDiscordMessage = Effect.fn('getDiscordMessage')(function* (
  discord: DiscordMessageGetAdapter,
  query: PlatformMessageGetQuery,
  policy: DiscordMessageGetPolicy,
) {
  const rawUrl = query.messageUrl?.trim()
  if (rawUrl !== undefined && rawUrl !== '') {
    return yield* getDiscordMessageByUrl(discord, query, policy, rawUrl)
  }
  if (query.messageId !== undefined) {
    return yield* getDiscordMessageById(discord, query)
  }
  return yield* messageNotFound('')
})

const getDiscordMessageById = Effect.fn('getDiscordMessageById')(function* (
  discord: DiscordMessageGetAdapter,
  query: PlatformMessageGetQuery,
) {
  const requestedId = String(query.messageId)
  const source = yield* Effect.try({
    try: () => targetThreadId(discord, query),
    catch: () => messageNotFound(requestedId),
  })
  const location = yield* Effect.try({
    try: () => discord.decodeThreadId(source),
    catch: () => messageNotFound(requestedId),
  })
  const channelId = location.threadId ?? location.channelId
  if (channelId === undefined) return yield* messageNotFound(requestedId)
  const message = yield* Effect.tryPromise({
    try: () => discord.fetchDirectMessage(channelId, requestedId),
    catch: () => messageNotFound(requestedId),
  })
  return { message: recordFrom(message) } satisfies PlatformMessageGetResult
})

const getDiscordMessageByUrl = Effect.fn('getDiscordMessageByUrl')(function* (
  discord: DiscordMessageGetAdapter,
  query: PlatformMessageGetQuery,
  policy: DiscordMessageGetPolicy,
  rawUrl: string,
) {
  const parsed = yield* parseDiscordMessageUrl(rawUrl)
  if (parsed.guildId === '@me') return yield* messageNotFound(parsed.messageId)
  const bindingId = yield* Effect.try({
    try: () => discord.decodeThreadId(String(query.binding.conversationId)),
    catch: () => messageNotFound(parsed.messageId),
  })
  if (bindingId.guildId === undefined || bindingId.guildId !== parsed.guildId) {
    return yield* messageNotFound(parsed.messageId)
  }
  const decodedId = Option.getOrUndefined(decodeMessageIdOption(parsed.messageId))
  if (decodedId === undefined) return yield* messageNotFound(parsed.messageId)
  // Thread URLs inherit their parent channel policy: only thread-typed
  // channels resolve through `parent_id`, everything else gates on the URL
  // channel itself.
  const info = yield* Effect.tryPromise({
    try: () =>
      discord.fetchChannelInfo(
        discord.encodeThreadId({ guildId: parsed.guildId, channelId: parsed.channelId }),
      ),
    catch: () => messageNotFound(parsed.messageId),
  })
  const thread = Option.getOrUndefined(decodeDiscordThreadChannel(info.metadata.raw))
  const effectiveChannelId = thread === undefined ? parsed.channelId : thread.parent_id
  if (policy.resolveChannelPolicy(parsed.guildId, effectiveChannelId) === undefined) {
    return yield* messageNotFound(parsed.messageId)
  }
  const message = yield* Effect.tryPromise({
    try: () => discord.fetchDirectMessage(parsed.channelId, String(decodedId)),
    catch: () => messageNotFound(parsed.messageId),
  })
  return { message: recordFrom(message) } satisfies PlatformMessageGetResult
})
