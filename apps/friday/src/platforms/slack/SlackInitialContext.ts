import { MessageAuthor, PlatformMessageId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { platformHistorySource } from '../PlatformAdapter.ts'
import { ChatSdkCallbackError } from '../chat-sdk/Errors.ts'
import type { SlackAdapter } from '@chat-adapter/slack'
import {
  decodeSlackConversationId,
  isSlackThread,
  toSlackAdapterChannelId,
  toSlackAdapterThreadId,
} from './SlackConversationScope.ts'

const MaximumRenderedCharacters = 8_000

const decodeAuthor = Schema.decodeUnknownSync(MessageAuthor)
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)

const SlackContextRaw = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
})
const decodeSlackContextRaw = Schema.decodeUnknownOption(SlackContextRaw)

interface SlackHistoryMessage {
  readonly id: string
  readonly text: string
  readonly author: {
    readonly userId: string
    readonly isBot: boolean | 'unknown'
    readonly isMe: boolean
  }
  readonly raw?: unknown
}

const isSlackContextBot = (message: SlackHistoryMessage): boolean => {
  const raw = Option.getOrUndefined(decodeSlackContextRaw(message.raw))
  return (
    message.author.isBot === true ||
    message.author.isMe === true ||
    raw?.bot_id !== undefined ||
    raw?.subtype === 'bot_message'
  )
}

const boundedSlackContext = (
  messages: ReadonlyArray<SlackHistoryMessage>,
  triggerId: string,
  afterMessageId?: string,
) => {
  const afterIndex =
    afterMessageId === undefined
      ? -1
      : messages.findIndex((message) => message.id === afterMessageId)
  if (afterMessageId !== undefined && afterIndex < 0) return []
  const candidates = messages.slice(afterIndex + 1)
  const context = []
  let characters = 0
  for (const message of candidates.toReversed()) {
    if (isSlackContextBot(message)) continue
    if (message.id === triggerId) continue
    const raw = Option.getOrUndefined(decodeSlackContextRaw(message.raw))
    const userId = raw?.user ?? message.author.userId
    const text = (raw?.text ?? message.text).trim()
    if (text.length === 0) continue
    if (characters + text.length > MaximumRenderedCharacters) break
    characters += text.length
    context.push({
      author: decodeAuthor({
        platformUserId: userId,
        mention: `<@${userId}>`,
        username: userId,
        displayName: userId,
      }),
      content: { text, images: [] },
      platformMessageId: decodeMessageId(message.id),
    })
  }
  return context.reverse()
}

export interface SlackContextAdapter extends Pick<
  SlackAdapter,
  'fetchMessages' | 'fetchChannelMessages'
> {}

export const shouldLoadSlackContext = (input: {
  readonly created: boolean
  readonly invocationMode: 'mention-only' | 'all-messages'
  readonly replyMode: 'reply-in-thread' | 'reply-in-channel'
}): boolean =>
  input.created || input.invocationMode === 'mention-only' || input.replyMode === 'reply-in-channel'

/**
 * Loads bounded recent Slack history as initial agent context via the official
 * adapter. Thread-scoped conversations read the native thread; channel roots
 * read the channel. Bot messages and the triggering message are skipped,
 * `afterMessageId` bounds repeated enrichment to messages after the last
 * saved user turn (missing cursor yields no context, avoiding replays), and
 * output is capped at 8,000 characters. Adapter ids are derived explicitly
 * from the canonical binding; persistence never adopts the transport identity.
 */
export const loadSlackInitialContext = Effect.fn('loadSlackInitialContext')(function* (
  adapter: SlackContextAdapter,
  recentMessageCount: number,
  input: PlatformInput,
  cursor: {
    readonly created: boolean
    readonly afterMessageId?: string | undefined
  } = { created: true },
) {
  if (recentMessageCount <= 0) return { ...input, initialContext: [] }
  const location = decodeSlackConversationId(String(input.binding.conversationId))
  if (location === undefined) return { ...input, initialContext: [] }
  const inThread = platformHistorySource(input) === 'thread' && isSlackThread(location)
  const limit = Math.min(Math.max(recentMessageCount, 1), 100)
  const page = yield* Effect.tryPromise({
    try: () =>
      inThread
        ? adapter.fetchMessages(toSlackAdapterThreadId(location), { limit })
        : adapter.fetchChannelMessages(toSlackAdapterChannelId(location), { limit }),
    catch: (cause) => new ChatSdkCallbackError({ operation: 'inbound-message', cause }),
  })
  const triggerId = String(input.message.platformMessageId ?? '')
  return {
    ...input,
    initialContext: boundedSlackContext(page.messages, triggerId, cursor.afterMessageId),
  }
})
