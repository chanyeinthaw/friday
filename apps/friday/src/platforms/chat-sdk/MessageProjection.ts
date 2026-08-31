import {
  PlatformChannelId,
  PlatformConnectionId,
  PlatformMessageId,
  PlatformKind,
  PlatformConversationId,
  MessageAuthor,
  ContextMessage,
  type ConversationBinding,
  type InputMessage,
} from '@friday/contracts/conversation'
import type { Message, Thread } from 'chat'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'

const decodePlatform = Schema.decodeUnknownSync(PlatformKind)
const decodeConnectionId = Schema.decodeUnknownSync(PlatformConnectionId)
const decodeChannelId = Schema.decodeUnknownSync(PlatformChannelId)
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeThreadId = Schema.decodeUnknownSync(PlatformConversationId)

export interface ChatSdkThreadProjectionSource extends Pick<Thread, 'channelId' | 'id'> {
  readonly adapter: Pick<Thread['adapter'], 'name'>
}

export type ChatSdkMessageProjectionSource = Pick<
  Message,
  'author' | 'id' | 'text' | 'isMention' | 'raw'
>

/** Context projection never inspects the raw payload, so callers need not supply it. */
export type ChatSdkContextMessageSource = Pick<
  ChatSdkMessageProjectionSource,
  'author' | 'id' | 'text'
>

// Only Discord embeds the replied-to message in the raw payload as
// `referenced_message`; raw decoding is gated on the binding's platform so other
// platforms never project reply context from structurally similar payloads.
// It is absent or null when the referenced message is unknown or deleted, so every
// field stays optional and decoding the whole payload is non-fatal by construction.
const DiscordReplyAuthor = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  username: Schema.optionalKey(Schema.String),
  global_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const DiscordReferencedMessage = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  content: Schema.optionalKey(Schema.String),
  author: DiscordReplyAuthor,
})

// Discord MESSAGE_REPLY is type 19; only such payloads carry reply intent, so
// referenced_message on any other type (e.g. pins, system messages) is ignored.
const DiscordRawMessage = Schema.Struct({
  type: Schema.Literal(19),
  referenced_message: Schema.optionalKey(Schema.NullOr(DiscordReferencedMessage)),
})

const decodeRawReply = Schema.decodeUnknownOption(DiscordRawMessage)
const decodeReplyAuthor = Schema.decodeUnknownOption(MessageAuthor)
const decodeAuthor = Schema.decodeUnknownSync(MessageAuthor)

const authorInput = (
  platform: ConversationBinding['platform'],
  platformUserId: string,
  username: string | null | undefined,
  displayName: string | null | undefined,
) => ({
  platformUserId,
  mention: platform === 'discord' ? `<@${platformUserId}>` : username || null,
  username: username || null,
  displayName: displayName || null,
})

type DiscordReferencedMessage = Schema.Schema.Type<typeof DiscordReferencedMessage>

/** Projects an embedded referenced message into reply context, or `undefined` when unusable. */
const replyTargetFrom = (
  platform: ConversationBinding['platform'],
  reply: DiscordReferencedMessage | null | undefined,
): ContextMessage | undefined => {
  if (reply === null || reply === undefined) return undefined
  // Content is preserved verbatim; trimming is only a blank-content guard.
  const text = reply.content ?? ''
  if (text.trim().length === 0) return undefined
  const author = decodeReplyAuthor(
    authorInput(platform, reply.author.id, reply.author.username, reply.author.global_name),
  )
  if (Option.isNone(author)) return undefined
  return {
    author: author.value,
    content: { text, images: [] },
    platformMessageId: decodeMessageId(reply.id),
  }
}

export const projectChatSdkContextMessage = (
  platform: ConversationBinding['platform'],
  message: ChatSdkContextMessageSource,
) => ({
  author: decodeAuthor(
    authorInput(platform, message.author.userId, message.author.userName, message.author.fullName),
  ),
  content: { text: message.text, images: [] },
  platformMessageId: decodeMessageId(message.id),
})

export const projectChatSdkMessage = (
  connectionId: string,
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
): PlatformInput => {
  const binding: ConversationBinding = {
    platform: decodePlatform(thread.adapter.name),
    connectionId: decodeConnectionId(connectionId),
    channelId: decodeChannelId(thread.channelId),
    sourceMessageId: decodeMessageId(message.id),
    conversationId: decodeThreadId(thread.id),
  }
  const projected = projectChatSdkContextMessage(binding.platform, message)
  const replyTo =
    binding.platform === 'discord'
      ? Option.flatMapNullishOr(decodeRawReply(message.raw), (payload) =>
          replyTargetFrom(binding.platform, payload.referenced_message),
        ).pipe(Option.getOrUndefined)
      : undefined
  const inputMessage: InputMessage = {
    source: 'user',
    author: projected.author,
    content: {
      text: message.text,
      images: [],
    },
    platformMessageId: binding.sourceMessageId,
  }
  return { binding, message: replyTo === undefined ? inputMessage : { ...inputMessage, replyTo } }
}
