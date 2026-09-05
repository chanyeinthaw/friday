/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- Chat SDK doubles mirror the narrow thread/message surface the acknowledge path touches. */
import { assert, it } from '@effect/vitest'
import {
  ConversationBinding,
  PlatformMessageId,
  type ConversationBinding as ConversationBindingType,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  makeChatSdkPlatform,
  type ChatSdkPublicationSource,
  type ChatSdkSentMessageSource,
} from './ChatSdkPlatform.ts'

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const THREAD = '333333333333333333'

const targetBinding: ConversationBindingType = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: `discord:${GUILD}:${CHANNEL}`,
  sourceMessageId: 'message-1',
  conversationId: `discord:${GUILD}:${CHANNEL}:${THREAD}`,
})
const platformMessageId = Schema.decodeSync(PlatformMessageId)

const makeRoutedSource = () => {
  const events: Array<string> = []
  const threadMessages: Array<ChatSdkSentMessageSource> = []
  const parentMessages: Array<ChatSdkSentMessageSource> = []
  const sent = (id: string): ChatSdkSentMessageSource => ({
    id,
    addReaction: async () => void events.push(`react:${id}`),
    delete: async () => undefined,
    edit: async () => sent(id),
  })
  // The source message lives in the parent channel; the new native thread is
  // still empty when the first acknowledgement runs.
  parentMessages.push(sent('message-1'))
  const source: ChatSdkPublicationSource = {
    thread: (key) => {
      const list =
        key === `discord:${GUILD}:${CHANNEL}` || key === 'discord:channel-1'
          ? parentMessages
          : threadMessages
      // Match the production routing: parent channel key carries the source,
      // the new thread key starts empty.
      const resolved =
        key === String(targetBinding.channelId)
          ? parentMessages
          : key === String(targetBinding.conversationId)
            ? threadMessages
            : list
      return {
        post: async () => ({}) as never,
        messages: {
          [Symbol.asyncIterator]: async function* () {
            for (const message of resolved.toReversed()) yield message
          },
        },
        createSentMessageFromMessage: (message: never) => {
          const found = resolved.find(({ id }) => id === (message as { id: string }).id)
          if (!found) return sent((message as { id: string }).id)
          return found
        },
      }
    },
  }
  return { source, events }
}

it.effect('acknowledges a routed first message through the parent channel', () =>
  Effect.gen(function* () {
    const test = makeRoutedSource()
    const platform = yield* makeChatSdkPlatform(targetBinding.connectionId, 'discord', test.source)
    // The rebound binding points at the empty native thread while the source
    // message still lives in the parent channel.
    yield* platform.acknowledge({
      binding: targetBinding,
      messageId: platformMessageId('message-1'),
    })
    assert.include(test.events, 'react:message-1')
  }),
)
