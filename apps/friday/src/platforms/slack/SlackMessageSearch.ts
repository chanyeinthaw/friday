import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { MessageAuthor, PlatformMessageId } from '@friday/contracts/conversation'
import type {
  PlatformMessageQuery,
  PlatformMessageRecord,
  PlatformMessageSearchResult,
} from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import type { Message } from 'chat'
import type { SlackAdapter } from '@chat-adapter/slack'
import {
  decodeSlackConversationId,
  isSlackThread,
  toSlackAdapterChannelId,
  toSlackAdapterThreadId,
} from './SlackConversationScope.ts'

const MaximumScanCount = 500
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeAuthor = Schema.decodeUnknownSync(MessageAuthor)

const SlackSearchRaw = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
})
const decodeSlackSearchRaw = Schema.decodeUnknownOption(SlackSearchRaw)

export interface SlackSearchAdapter extends Pick<
  SlackAdapter,
  'fetchMessages' | 'fetchChannelMessages'
> {}

type SearchMessage = Message

const recordFrom = (message: SearchMessage): PlatformMessageRecord | undefined => {
  const raw = Option.getOrUndefined(decodeSlackSearchRaw(message.raw))
  const userId = raw?.user ?? message.author.userId
  if (userId === '') return undefined
  const text = raw?.text ?? message.text
  const threadTs = raw?.thread_ts
  return {
    id: decodeMessageId(message.id),
    author: decodeAuthor({
      platformUserId: userId,
      mention: `<@${userId}>`,
      username: userId,
      displayName: userId,
    }),
    text,
    sentAt: null,
    replyToMessageId: threadTs === undefined ? null : decodeMessageId(threadTs),
  }
}

const isBotMessage = (message: SearchMessage): boolean => {
  if (message.author.isBot === true || message.author.isMe === true) return true
  const raw = Option.getOrUndefined(decodeSlackSearchRaw(message.raw))
  return raw?.bot_id !== undefined || raw?.subtype === 'bot_message'
}

const messageMatches = (
  message: SearchMessage,
  needle: string | undefined,
  authorId: string | undefined,
): boolean => {
  const raw = Option.getOrUndefined(decodeSlackSearchRaw(message.raw))
  if (authorId !== undefined && (raw?.user ?? message.author.userId) !== authorId) return false
  if (needle === undefined) return true
  return (raw?.text ?? message.text).toLocaleLowerCase().includes(needle)
}

const readSearchPage = (
  adapter: SlackSearchAdapter,
  inThread: boolean,
  threadId: string,
  channelId: string,
  limit: number,
  cursor: string | undefined,
) => {
  if (inThread) {
    return cursor === undefined
      ? adapter.fetchMessages(threadId, { limit })
      : adapter.fetchMessages(threadId, { limit, cursor })
  }
  return cursor === undefined
    ? adapter.fetchChannelMessages(channelId, { limit })
    : adapter.fetchChannelMessages(channelId, { limit, cursor })
}

/**
 * Searches Slack history with Friday's preserved semantics: thread scope reads
 * the native thread, channel scope reads the channel; bot messages are
 * skipped and text/author filters apply in memory. Adapter thread ids are
 * derived explicitly from the canonical binding so persistence never adopts
 * the team-less transport identity.
 */
export const searchSlackMessages = Effect.fn('searchSlackMessages')(function* (
  adapter: SlackSearchAdapter,
  query: PlatformMessageQuery,
) {
  const location = decodeSlackConversationId(String(query.binding.conversationId))
  if (location === undefined) {
    return yield* new ChatSdkPublicationError({ operation: 'publish', cause: 'unknown-thread' })
  }
  const inThread = query.scope === 'thread' && isSlackThread(location)
  const threadId = toSlackAdapterThreadId(location)
  const channelId = toSlackAdapterChannelId(location)
  const matches: Array<PlatformMessageRecord> = []
  const needle = query.query?.trim().toLocaleLowerCase()
  let cursor = query.before === undefined ? undefined : String(query.before)
  let scannedCount = 0
  let hasMore = true

  while (matches.length < query.limit && scannedCount < MaximumScanCount && hasMore) {
    const remaining = Math.min(100, MaximumScanCount - scannedCount)
    const page = yield* Effect.tryPromise({
      try: () => readSearchPage(adapter, inThread, threadId, channelId, remaining, cursor),
      catch: (cause) => new ChatSdkPublicationError({ operation: 'publish', cause }),
    })
    scannedCount += page.messages.length
    for (const message of page.messages.toReversed()) {
      if (isBotMessage(message)) continue
      if (!messageMatches(message, needle, query.authorId)) continue
      const record = recordFrom(message)
      if (record === undefined) continue
      matches.push(record)
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
