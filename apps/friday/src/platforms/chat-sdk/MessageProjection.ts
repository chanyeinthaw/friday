import {
  PlatformChannelId,
  PlatformMessageId,
  PlatformKind,
  PlatformConversationId,
  type ConversationBinding,
  type InputMessage,
} from '@friday/contracts/conversation'
import type { Message, Thread } from 'chat'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'

const decodePlatform = Schema.decodeUnknownSync(PlatformKind)
const decodeChannelId = Schema.decodeUnknownSync(PlatformChannelId)
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeThreadId = Schema.decodeUnknownSync(PlatformConversationId)

export interface ChatSdkThreadProjectionSource extends Pick<Thread, 'channelId' | 'id'> {
  readonly adapter: Pick<Thread['adapter'], 'name'>
}

export type ChatSdkMessageProjectionSource = Pick<Message, 'author' | 'id' | 'text'>

export const projectChatSdkMessage = (
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
): PlatformInput => {
  const binding: ConversationBinding = {
    platform: decodePlatform(thread.adapter.name),
    channelId: decodeChannelId(thread.channelId),
    sourceMessageId: decodeMessageId(message.id),
    conversationId: decodeThreadId(thread.id),
  }
  const inputMessage: InputMessage = {
    source: 'user',
    content: {
      text: message.text,
      images: [],
    },
    platformMessageId: binding.sourceMessageId,
  }
  return { binding, message: inputMessage }
}
