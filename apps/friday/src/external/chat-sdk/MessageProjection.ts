import {
  ExternalChannelId,
  ExternalMessageId,
  ExternalPlatform,
  ExternalThreadId,
  type ExternalBinding,
  type InputMessage,
} from '@friday/contracts/conversation'
import type { Message, Thread } from 'chat'
import * as Schema from 'effect/Schema'

import type { ExternalInboundMessage } from '../ExternalPlatform.ts'

const decodePlatform = Schema.decodeUnknownSync(ExternalPlatform)
const decodeChannelId = Schema.decodeUnknownSync(ExternalChannelId)
const decodeMessageId = Schema.decodeUnknownSync(ExternalMessageId)
const decodeThreadId = Schema.decodeUnknownSync(ExternalThreadId)

export interface ChatSdkThreadProjectionSource extends Pick<Thread, 'channelId' | 'id'> {
  readonly adapter: Pick<Thread['adapter'], 'name'>
}
export type ChatSdkMessageProjectionSource = Pick<Message, 'id' | 'text'>

export const projectChatSdkMessage = (
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
): ExternalInboundMessage => {
  const binding: ExternalBinding = {
    platform: decodePlatform(thread.adapter.name),
    channelId: decodeChannelId(thread.channelId),
    sourceMessageId: decodeMessageId(message.id),
    externalThreadId: decodeThreadId(thread.id),
  }
  const inputMessage: InputMessage = {
    source: 'user',
    content: {
      text: message.text,
      images: [],
    },
    externalMessageId: binding.sourceMessageId,
  }
  return { binding, message: inputMessage }
}
