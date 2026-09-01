import { assert, it } from '@effect/vitest'
import {
  ConversationBinding,
  InputMessage,
  PlatformConversationId,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { loadDiscordInitialContext, shouldLoadDiscordContext } from './DiscordInitialContext.ts'

const decodeConversationId = Schema.decodeSync(PlatformConversationId)
const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  conversationId: 'discord:guild-1:channel-1:thread-1',
  sourceMessageId: 'trigger-1',
})
const trigger = Schema.decodeSync(InputMessage)({
  source: 'user',
  author: {
    platformUserId: 'user-1',
    mention: '<@user-1>',
    username: 'chan',
    displayName: 'Chan',
  },
  content: { text: 'Friday, investigate.', images: [] },
  platformMessageId: 'trigger-1',
})
const author = (id: string, bot = false) => ({
  userId: id,
  userName: id,
  fullName: id,
  isBot: bot,
  isMe: bot,
})
const message = (id: string, text: string, bot = false) => ({
  id,
  threadId: 'thread-1',
  text,
  author: author(id, bot),
})

it('loads context for new bindings, mention-only invocations, and reply-in-channel transport', () => {
  assert.strictEqual(
    shouldLoadDiscordContext({
      created: true,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-thread',
    }),
    true,
  )
  assert.strictEqual(
    shouldLoadDiscordContext({
      created: false,
      invocationMode: 'mention-only',
      replyMode: 'reply-in-thread',
    }),
    true,
  )
  assert.strictEqual(
    shouldLoadDiscordContext({
      created: false,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-channel',
    }),
    true,
  )
  assert.strictEqual(
    shouldLoadDiscordContext({
      created: false,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-thread',
    }),
    false,
  )
})

it.effect('loads recent context from an existing Discord thread once at creation input', () =>
  Effect.gen(function* () {
    const fetched: Array<string> = []
    const input = yield* loadDiscordInitialContext(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
        }),
        encodeThreadId: () => 'unused',
        fetchMessages: (threadId) => {
          fetched.push(threadId)
          return Promise.resolve({
            messages: [
              message('earlier-1', 'Earlier context.'),
              message('bot-1', 'Friday output.', true),
              message('trigger-1', 'Friday, investigate.'),
            ],
          })
        },
      },
      20,
      { binding, message: trigger },
    )

    assert.deepStrictEqual(fetched, ['discord:guild-1:channel-1:thread-1'])
    assert.deepStrictEqual(
      input.initialContext?.map(({ content }) => content.text),
      ['Earlier context.'],
    )
  }),
)

it.effect('loads parent-channel context when Friday creates a reply thread from the trigger', () =>
  Effect.gen(function* () {
    const fetched: Array<string> = []
    const input = yield* loadDiscordInitialContext(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'trigger-1',
        }),
        encodeThreadId: ({ guildId, channelId, threadId }) =>
          `discord:${guildId}:${channelId}:${threadId}`,
        fetchMessages: (threadId) => {
          fetched.push(threadId)
          return Promise.resolve({ messages: [message('earlier-1', 'Parent discussion.')] })
        },
      },
      20,
      {
        binding: {
          ...binding,
          conversationId: decodeConversationId('discord:guild-1:channel-1:trigger-1'),
        },
        message: trigger,
      },
    )

    assert.deepStrictEqual(fetched, ['discord:guild-1:channel-1:channel-1'])
    assert.strictEqual(input.initialContext?.[0]?.content.text, 'Parent discussion.')
  }),
)

it.effect('loads only missed messages after the latest ingested platform message', () =>
  Effect.gen(function* () {
    const fetches: Array<unknown> = []
    const input = yield* loadDiscordInitialContext(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
        }),
        encodeThreadId: () => 'unused',
        fetchMessages: (_threadId, options) => {
          fetches.push(options)
          return Promise.resolve({
            messages: [
              message('message-before', 'Already ingested.'),
              message('missed-1', 'Missed one.'),
              message('bot-1', 'Friday output.', true),
              message('missed-2', 'Missed two.'),
              message('trigger-1', 'Friday, investigate.'),
            ],
          })
        },
      },
      20,
      { binding, message: trigger },
      { created: false, afterMessageId: 'message-before' },
    )

    assert.deepStrictEqual(fetches, [{ limit: 20 }])
    assert.deepStrictEqual(
      input.initialContext?.map(({ content }) => content.text),
      ['Missed one.', 'Missed two.'],
    )
  }),
)

it.effect('loads parent-channel context for a normal channel start', () =>
  Effect.gen(function* () {
    const fetched: Array<string> = []
    const input = yield* loadDiscordInitialContext(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'channel-1',
        }),
        encodeThreadId: ({ guildId, channelId, threadId }) =>
          `discord:${guildId}:${channelId}:${threadId}`,
        fetchMessages: (threadId) => {
          fetched.push(threadId)
          return Promise.resolve({ messages: [message('earlier-1', 'Channel context.')] })
        },
      },
      20,
      {
        binding: {
          ...binding,
          conversationId: decodeConversationId('discord:guild-1:channel-1:channel-1'),
        },
        message: trigger,
      },
    )

    assert.deepStrictEqual(fetched, ['discord:guild-1:channel-1:channel-1'])
    assert.strictEqual(input.initialContext?.[0]?.content.text, 'Channel context.')
  }),
)
