import {
  PlatformChannelId,
  PlatformConnectionId,
  PlatformMessageId,
  PlatformKind,
  PlatformConversationId,
  MessageAuthor,
  type ConversationBinding,
  type InputMessage,
} from '@friday/contracts/conversation'
import type { Message, Thread } from 'chat'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'

const decodePlatform = Schema.decodeUnknownSync(PlatformKind)
const decodeConnectionId = Schema.decodeUnknownSync(PlatformConnectionId)
const decodeChannelId = Schema.decodeUnknownSync(PlatformChannelId)
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeThreadId = Schema.decodeUnknownSync(PlatformConversationId)
const decodeAuthor = Schema.decodeUnknownSync(MessageAuthor)

export interface ChatSdkThreadProjectionSource extends Pick<Thread, 'channelId' | 'id'> {
  readonly adapter: Pick<Thread['adapter'], 'name'>
}

export type ChatSdkMessageProjectionSource = Pick<Message, 'author' | 'id' | 'text'>

export const projectChatSdkContextMessage = (
  platform: ConversationBinding['platform'],
  message: ChatSdkMessageProjectionSource,
) => ({
  author: decodeAuthor({
    platformUserId: message.author.userId,
    mention:
      platform === 'discord' ? `<@${message.author.userId}>` : message.author.userName || null,
    username: message.author.userName || null,
    displayName: message.author.fullName || null,
  }),
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
  const inputMessage: InputMessage = {
    source: 'user',
    author: projectChatSdkContextMessage(binding.platform, message).author,
    content: {
      text: message.text,
      images: [],
    },
    platformMessageId: binding.sourceMessageId,
  }
  return { binding, message: inputMessage }
}
