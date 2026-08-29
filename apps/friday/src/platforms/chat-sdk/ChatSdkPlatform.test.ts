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
  splitMessage,
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
const platformMessageId = Schema.decodeSync(PlatformMessageId)

interface TestMessage extends ChatSdkSentMessageSource {
  text: string
}

const makeSource = () => {
  const threadMessages: Array<TestMessage> = []
  const parentMessages: Array<TestMessage> = []
  const events: Array<string> = []
  const sent = (
    id: string,
    text: string,
    addReaction: () => Promise<void> = async () => void events.push(`react:${id}`),
  ): TestMessage => {
    const message: TestMessage = {
      id,
      text,
      addReaction,
      delete: async () => {
        events.push(`delete:${id}`)
        const index = threadMessages.indexOf(message)
        if (index >= 0) threadMessages.splice(index, 1)
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
    thread: (key) => {
      // The parent channel is addressed by its own key; reactions to a
      // thread starter must be resolved there.
      const list = key === 'discord:channel-1' ? parentMessages : threadMessages
      return {
        post: async (text) => {
          const message = sent(`bot-${threadMessages.length + 1}`, text)
          threadMessages.push(message)
          events.push(`post:${message.id}:${text}`)
          return message
        },
        messages: {
          [Symbol.asyncIterator]: async function* () {
            for (const message of list.toReversed()) yield message
          },
        },
        createSentMessageFromMessage: (message: never) => {
          // SAFETY: The production boundary passes only objects with the required message id.
          const source = message as ChatSdkMessageSource
          return list.find(({ id }) => id === source.id) ?? sent(source.id, '')
        },
      }
    },
  }
  return {
    source,
    messages: threadMessages,
    parentMessages,
    events,
    addUser: (id: string, addReaction?: () => Promise<void>) => {
      const message = sent(id, 'user', addReaction)
      threadMessages.push(message)
      return message
    },
    addParent: (id: string) => {
      const message = sent(id, 'user')
      parentMessages.push(message)
      return message
    },
  }
}

it('splits messages at readable boundaries without exceeding the limit', () => {
  const text = `${'a'.repeat(12)}\n\n${'b'.repeat(12)} ${'c'.repeat(12)}`
  const chunks = splitMessage(text, 20)

  assert.deepStrictEqual(chunks, [`${'a'.repeat(12)}\n\n`, `${'b'.repeat(12)} `, 'c'.repeat(12)])
  assert(chunks.every((chunk) => chunk.length <= 20))
  assert.strictEqual(chunks.join(''), text)
})

it('does not split a Unicode surrogate pair at the hard boundary', () => {
  const text = `${'a'.repeat(9)}😀b`
  const chunks = splitMessage(text, 10)

  assert.deepStrictEqual(chunks, ['a'.repeat(9), '😀b'])
  assert.strictEqual(chunks.join(''), text)
})

it.effect('acknowledges an accepted user message', () =>
  Effect.gen(function* () {
    const test = makeSource()
    test.addUser('message-2')
    const platform = yield* makeChatSdkPlatform('discord', test.source)

    yield* platform.acknowledge({ binding, messageId: platformMessageId('message-2') })

    assert.include(test.events, 'react:message-2')
  }),
)

it.effect('acknowledges a thread starter through the parent channel', () =>
  Effect.gen(function* () {
    const test = makeSource()
    test.addParent('message-1')
    test.addUser('message-1', async () => {
      throw new Error('Discord API error: 404 Unknown Message')
    })
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

it.effect('splits a long final answer after editing the latest working message', () =>
  Effect.gen(function* () {
    const test = makeSource()
    const platform = yield* makeChatSdkPlatform('discord', test.source, {
      maxMessageLength: 10,
    })

    yield* platform.beginWorking({ binding, text: 'Thinking' })
    yield* platform.finalizeWorking({ binding, text: '1234567890abcdefghijXYZ' })

    assert.deepStrictEqual(test.events, [
      'post:bot-1:Thinking',
      'edit:bot-1:1234567890',
      'post:bot-2:abcdefghij',
      'post:bot-3:XYZ',
    ])
  }),
)

it.effect('splits a long final answer after deleting a stale working message', () =>
  Effect.gen(function* () {
    const test = makeSource()
    const platform = yield* makeChatSdkPlatform('discord', test.source, {
      maxMessageLength: 10,
    })

    yield* platform.beginWorking({ binding, text: 'Thinking' })
    test.addUser('steering-message')
    yield* platform.finalizeWorking({ binding, text: '1234567890abcdefghijXYZ' })

    assert.deepStrictEqual(test.events, [
      'post:bot-1:Thinking',
      'delete:bot-1',
      'post:bot-2:1234567890',
      'post:bot-3:abcdefghij',
      'post:bot-4:XYZ',
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
