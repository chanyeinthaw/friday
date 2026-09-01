import { assert, it } from '@effect/vitest'
import {
  ConversationBinding,
  InputMessage,
  PlatformConversationId,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { loadDiscordInitialContext } from './DiscordInitialContext.ts'

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
