import { assert, it } from '@effect/vitest'
import {
  ConversationBinding,
  type ConversationBinding as ConversationBindingType,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  makeChatSdkPlatform,
  type ChatSdkMessageSource,
  type ChatSdkPublicationSource,
  type ChatSdkSentMessageSource,
} from './ChatSdkPlatform.ts'

const binding: ConversationBindingType = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  channelId: 'discord:channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'discord:channel-1:message-1',
})

interface TestMessage extends ChatSdkSentMessageSource {
  text: string
}

const makeSource = () => {
  const messages: Array<TestMessage> = []
  const events: Array<string> = []
  const sent = (id: string, text: string): TestMessage => {
    const message: TestMessage = {
      id,
      text,
      addReaction: async () => void events.push(`react:${id}`),
      delete: async () => {
        events.push(`delete:${id}`)
        const index = messages.indexOf(message)
        if (index >= 0) messages.splice(index, 1)
      },
      edit: async (next) => {
        events.push(`edit:${id}:${next}`)
        message.text = next
        return message
      },
    }
    return message
  }
  const source: ChatSdkPublicationSource = {
    thread: () => ({
      post: async (text) => {
        const message = sent(`bot-${messages.length + 1}`, text)
        messages.push(message)
        events.push(`post:${message.id}:${text}`)
        return message
      },
      messages: {
        [Symbol.asyncIterator]: async function* () {
          for (const message of messages.toReversed()) yield message
        },
      },
      createSentMessageFromMessage: (message: never) => {
        // SAFETY: The production boundary passes only objects with the required message id.
        const source = message as ChatSdkMessageSource
        return messages.find(({ id }) => id === source.id) ?? sent(source.id, '')
      },
    }),
  }
  return { source, messages, events, addUser: (id: string) => messages.push(sent(id, 'user')) }
}

it.effect('acknowledges an accepted user message', () =>
  Effect.gen(function* () {
    const test = makeSource()
    test.addUser('message-1')
    const platform = yield* makeChatSdkPlatform('discord', test.source)

    yield* platform.acknowledge({ binding, messageId: binding.sourceMessageId })

    assert.include(test.events, 'react:message-1')
  }),
)

it.effect('edits the working message when it remains latest', () =>
  Effect.gen(function* () {
    const test = makeSource()
    const platform = yield* makeChatSdkPlatform('discord', test.source)

    yield* platform.beginWorking({ binding, text: '-# Thinking...' })
    yield* platform.updateWorking({ binding, text: '-# Reading files...' })
    yield* platform.finalizeWorking({ binding, text: 'Final answer.' })

    assert.deepStrictEqual(test.events, [
      'post:bot-1:-# Thinking...',
      'edit:bot-1:-# Reading files...',
      'edit:bot-1:Final answer.',
    ])
  }),
)

it.effect('deletes a stale working message and posts the final answer at the bottom', () =>
  Effect.gen(function* () {
    const test = makeSource()
    const platform = yield* makeChatSdkPlatform('discord', test.source)

    yield* platform.beginWorking({ binding, text: '-# Thinking...' })
    test.addUser('steering-message')
    yield* platform.finalizeWorking({ binding, text: 'Final answer.' })

    assert.deepStrictEqual(test.events, [
      'post:bot-1:-# Thinking...',
      'delete:bot-1',
      'post:bot-2:Final answer.',
    ])
  }),
)
