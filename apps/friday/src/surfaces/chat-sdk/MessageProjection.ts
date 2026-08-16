import {
  SurfaceChannelId,
  SurfaceMessageId,
  SurfaceKind,
  SurfaceConversationId,
  type SurfaceBinding,
  type InputMessage,
} from '@friday/contracts/conversation'
import type { Message, Thread } from 'chat'
import * as Schema from 'effect/Schema'

import type { SurfaceInput } from '../Surface.ts'

const decodePlatform = Schema.decodeUnknownSync(SurfaceKind)
const decodeChannelId = Schema.decodeUnknownSync(SurfaceChannelId)
const decodeMessageId = Schema.decodeUnknownSync(SurfaceMessageId)
const decodeThreadId = Schema.decodeUnknownSync(SurfaceConversationId)

export interface ChatSdkThreadProjectionSource extends Pick<Thread, 'channelId' | 'id'> {
  readonly adapter: Pick<Thread['adapter'], 'name'>
}
export type ChatSdkMessageProjectionSource = Pick<Message, 'id' | 'text'>

export const projectChatSdkMessage = (
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
): SurfaceInput => {
  const binding: SurfaceBinding = {
    surface: decodePlatform(thread.adapter.name),
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
    surfaceMessageId: binding.sourceMessageId,
  }
  return { binding, message: inputMessage }
}
