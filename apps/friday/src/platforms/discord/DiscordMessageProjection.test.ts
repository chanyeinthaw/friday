import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { projectDiscordMessage } from './DiscordMessageProjection.ts'

const message = {
  id: 'thread-1',
  text: 'Hello Friday',
  raw: {},
  author: {
    userId: 'user-1',
    userName: 'user',
    fullName: 'User',
    isBot: false,
    isMe: false,
  },
}

const thread = {
  adapter: { name: 'discord' },
  channelId: 'discord:guild-1:channel-1',
  id: 'discord:guild-1:channel-1',
}

it.effect('repairs a pre-existing Discord thread starter projected as its parent channel', () =>
  Effect.gen(function* () {
    const input = yield* projectDiscordMessage(
      'discord',
      {
        decodeThreadId: () => ({ guildId: 'guild-1', channelId: 'channel-1' }),
        encodeThreadId: ({ guildId, channelId, threadId }) =>
          `discord:${guildId}:${channelId}:${threadId}`,
        fetchChannelInfo: () =>
          Promise.resolve({
            id: 'discord:guild-1:thread-1',
            name: 'Manual thread',
            isDM: false,
            metadata: { raw: { id: 'thread-1', parent_id: 'channel-1', type: 11 } },
          }),
      },
      thread,
      message,
    )

    assert.strictEqual(input.binding.channelId, 'discord:guild-1:channel-1')
    assert.strictEqual(input.binding.conversationId, 'discord:guild-1:channel-1:thread-1')
    assert.strictEqual(input.binding.sourceMessageId, 'thread-1')
  }),
)

it.effect('keeps an ordinary channel message in the parent channel', () =>
  Effect.gen(function* () {
    // SAFETY: The prototype supplies the required adapter while own properties below supply channelId and id.
    const sdkThread = Object.create({ adapter: { name: 'discord' } }) as typeof thread
    Object.assign(sdkThread, {
      channelId: 'discord:guild-1:channel-1',
      id: 'discord:guild-1:channel-1',
    })
    const input = yield* projectDiscordMessage(
      'discord',
      {
        decodeThreadId: () => ({ guildId: 'guild-1', channelId: 'channel-1' }),
        encodeThreadId: ({ guildId, channelId, threadId }) =>
          `discord:${guildId}:${channelId}:${threadId}`,
        fetchChannelInfo: () => Promise.reject(new Error('not found')),
      },
      sdkThread,
      message,
    )

    assert.strictEqual(input.binding.conversationId, 'discord:guild-1:channel-1:channel-1')
  }),
)

it.effect('preserves messages already projected inside a Discord thread', () =>
  Effect.gen(function* () {
    let fetched = false
    const input = yield* projectDiscordMessage(
      'discord',
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
        }),
        encodeThreadId: () => 'unused',
        fetchChannelInfo: () => {
          fetched = true
          return Promise.reject(new Error('should not fetch'))
        },
      },
      { ...thread, id: 'discord:guild-1:channel-1:thread-1' },
      { ...message, id: 'message-2' },
    )

    assert.strictEqual(input.binding.conversationId, 'discord:guild-1:channel-1:thread-1')
    assert.strictEqual(fetched, false)
  }),
)
