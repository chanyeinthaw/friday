import { assert, it } from '@effect/vitest'

import {
  isDiscordSystemChannel,
  projectDiscordSystemChannelMessage,
} from './DiscordSystemChannel.ts'

const discord = {
  decodeThreadId: (value: string) => {
    const [, guildId, channelId, threadId] = value.split(':')
    if (guildId === undefined || channelId === undefined) throw new Error('Invalid thread ID')
    return threadId === undefined ? { guildId, channelId } : { guildId, channelId, threadId }
  },
  encodeThreadId: ({
    guildId,
    channelId,
    threadId,
  }: {
    guildId: string
    channelId: string
    threadId?: string
  }) => ['discord', guildId, channelId, threadId].filter(Boolean).join(':'),
}

const channelThread = {
  adapter: { name: 'discord' },
  channelId: 'discord:guild-1:channel-1',
  id: 'discord:guild-1:channel-1',
}

const message = {
  id: 'message-1',
  text: 'inspect Friday',
  isMention: true,
  author: {
    userId: 'user-1',
    userName: 'chan',
    fullName: 'Chan',
    isBot: false,
    isMe: false,
  },
}

it('recognizes configured parent channels but not Discord child threads', () => {
  assert.strictEqual(isDiscordSystemChannel(discord, channelThread, ['channel-1']), true)
  assert.strictEqual(
    isDiscordSystemChannel(
      discord,
      { ...channelThread, id: 'discord:guild-1:channel-1:channel-1' },
      ['channel-1'],
    ),
    true,
  )
  assert.strictEqual(
    isDiscordSystemChannel(
      discord,
      { ...channelThread, id: 'discord:guild-1:channel-1:thread-1' },
      ['channel-1'],
    ),
    false,
  )
})

it('binds system messages to the parent channel conversation', () => {
  const input = projectDiscordSystemChannelMessage('discord', discord, channelThread, message)
  assert.strictEqual(input.binding.channelId, 'discord:guild-1:channel-1')
  assert.strictEqual(input.binding.conversationId, 'discord:guild-1:channel-1')
  assert.strictEqual(input.binding.sourceMessageId, 'message-1')
})
