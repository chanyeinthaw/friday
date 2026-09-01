import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import { Message } from 'chat'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { searchDiscordMessages } from './DiscordMessageSearch.ts'

const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'message-3',
  conversationId: 'discord:guild-1:channel-1:thread-1',
})
const message = (id: string, text: string, userId = 'user-1') =>
  new Message({
    id,
    threadId: 'discord:guild-1:channel-1:thread-1',
    text,
    formatted: { type: 'root', children: [] },
    raw: {},
    author: { userId, userName: userId, fullName: userId, isBot: false, isMe: false },
    metadata: { dateSent: new Date('2026-03-21T09:00:00.000Z'), edited: false },
    attachments: [],
  })

it.effect('searches the current thread and returns attributed messages', () =>
  Effect.gen(function* () {
    const sources: Array<string> = []
    const result = yield* searchDiscordMessages(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
        }),
        encodeThreadId: ({ guildId, channelId, threadId }) =>
          `discord:${guildId}:${channelId}:${threadId}`,
        fetchMessages: (source) => {
          sources.push(source)
          return Promise.resolve({
            messages: [
              message('message-1', 'Dokploy deploy failed', 'user-1'),
              message('message-2', 'Unrelated note', 'user-2'),
            ],
          })
        },
      },
      { binding, scope: 'thread', query: 'dokploy', limit: 20 },
    )

    assert.deepStrictEqual(sources, ['discord:guild-1:channel-1:thread-1'])
    assert.strictEqual(result.messages.length, 1)
    assert.strictEqual(result.messages[0]?.text, 'Dokploy deploy failed')
    assert.strictEqual(result.scannedCount, 2)
    assert.strictEqual(result.truncated, false)
  }),
)

it.effect('fetches from the parent channel when channel scope is requested', () =>
  Effect.gen(function* () {
    const sources: Array<string> = []
    yield* searchDiscordMessages(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
        }),
        encodeThreadId: ({ guildId, channelId, threadId }) =>
          `discord:${guildId}:${channelId}:${threadId}`,
        fetchMessages: (source) => {
          sources.push(source)
          return Promise.resolve({ messages: [] })
        },
      },
      { binding, scope: 'channel', limit: 20 },
    )

    assert.deepStrictEqual(sources, ['discord:guild-1:channel-1:channel-1'])
  }),
)
