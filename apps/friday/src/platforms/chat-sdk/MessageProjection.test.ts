import { assert, it } from '@effect/vitest'

import { projectChatSdkMessage } from './MessageProjection.ts'

it('projects Chat SDK identifiers and text into Friday contracts', () => {
  const inbound = projectChatSdkMessage(
    {
      adapter: { name: 'discord' },
      channelId: 'discord-channel-1',
      id: 'discord-thread-1',
    },
    {
      id: 'discord-message-1',
      text: 'Hello Friday',
      author: {
        userId: 'user-1',
        userName: 'user',
        fullName: 'User',
        isBot: false,
        isMe: false,
      },
    },
  )

  assert.strictEqual(inbound.binding.platform, 'discord')
  assert.strictEqual(String(inbound.binding.channelId), 'discord-channel-1')
  assert.strictEqual(String(inbound.binding.sourceMessageId), 'discord-message-1')
  assert.strictEqual(String(inbound.binding.conversationId), 'discord-thread-1')
  assert.strictEqual(inbound.message.source, 'user')
  assert.strictEqual(String(inbound.message.author?.platformUserId), 'user-1')
  assert.strictEqual(inbound.message.author?.username, 'user')
  assert.strictEqual(inbound.message.author?.displayName, 'User')
  assert.strictEqual(inbound.message.content.text, 'Hello Friday')
  assert.deepStrictEqual(inbound.message.content.images, [])
  assert.strictEqual(String(inbound.message.platformMessageId), 'discord-message-1')
})
