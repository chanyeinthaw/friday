import { assert, it } from '@effect/vitest'

import { projectChatSdkContextMessage, projectChatSdkMessage } from './MessageProjection.ts'

const discordRawReply = {
  type: 19,
  referenced_message: {
    id: 'discord-message-0',
    content: 'The original question',
    author: { id: 'user-0', username: 'bob', global_name: 'Bob' },
  },
}

it('projects Chat SDK identifiers and text into Friday contracts', () => {
  const inbound = projectChatSdkMessage(
    'discord',
    {
      adapter: { name: 'discord' },
      channelId: 'discord-channel-1',
      id: 'discord-thread-1',
    },
    {
      id: 'discord-message-1',
      text: 'Hello Friday',
      raw: {},
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
  assert.strictEqual(inbound.message.author?.mention, '<@user-1>')
  assert.strictEqual(inbound.message.author?.username, 'user')
  assert.strictEqual(inbound.message.author?.displayName, 'User')
  assert.strictEqual(inbound.message.content.text, 'Hello Friday')
  assert.deepStrictEqual(inbound.message.content.images, [])
  assert.strictEqual(String(inbound.message.platformMessageId), 'discord-message-1')
  assert.strictEqual(inbound.message.replyTo, undefined)
})

it('projects the referenced message of a Discord reply from the raw payload', () => {
  const inbound = projectChatSdkMessage(
    'discord',
    {
      adapter: { name: 'discord' },
      channelId: 'discord-channel-1',
      id: 'discord-thread-1',
    },
    {
      id: 'discord-message-1',
      text: 'What did you mean?',
      raw: discordRawReply,
      author: {
        userId: 'user-1',
        userName: 'user',
        fullName: 'User',
        isBot: false,
        isMe: false,
      },
    },
  )

  const replyTo = inbound.message.replyTo
  assert(replyTo !== undefined)
  assert.strictEqual(String(replyTo.platformMessageId), 'discord-message-0')
  assert.strictEqual(String(replyTo.author.platformUserId), 'user-0')
  assert.strictEqual(replyTo.author.mention, '<@user-0>')
  assert.strictEqual(replyTo.author.username, 'bob')
  assert.strictEqual(replyTo.author.displayName, 'Bob')
  assert.strictEqual(replyTo.content.text, 'The original question')
  assert.deepStrictEqual(replyTo.content.images, [])
})

it('drops reply context when the raw Discord message type is not 19', () => {
  const inbound = projectChatSdkMessage(
    'discord',
    {
      adapter: { name: 'discord' },
      channelId: 'discord-channel-1',
      id: 'discord-thread-1',
    },
    {
      id: 'discord-message-1',
      text: 'What did you mean?',
      raw: {
        type: 0,
        referenced_message: {
          id: 'discord-message-0',
          content: 'The original question',
          author: { id: 'user-0', username: 'bob', global_name: 'Bob' },
        },
      },
      author: {
        userId: 'user-1',
        userName: 'user',
        fullName: 'User',
        isBot: false,
        isMe: false,
      },
    },
  )

  assert.strictEqual(inbound.message.replyTo, undefined)
})

it('preserves leading and trailing whitespace in referenced message content', () => {
  const inbound = projectChatSdkMessage(
    'discord',
    {
      adapter: { name: 'discord' },
      channelId: 'discord-channel-1',
      id: 'discord-thread-1',
    },
    {
      id: 'discord-message-1',
      text: 'What did you mean?',
      raw: {
        type: 19,
        referenced_message: {
          id: 'discord-message-0',
          content: '    indented line\n\ntrailing line   \n',
          author: { id: 'user-0', username: 'bob', global_name: 'Bob' },
        },
      },
      author: {
        userId: 'user-1',
        userName: 'user',
        fullName: 'User',
        isBot: false,
        isMe: false,
      },
    },
  )

  const replyTo = inbound.message.replyTo
  assert(replyTo !== undefined)
  assert.strictEqual(replyTo.content.text, '    indented line\n\ntrailing line   \n')
})

it('ignores Discord-shaped raw replies on non-Discord bindings', () => {
  const inbound = projectChatSdkMessage(
    'slack-connection',
    {
      adapter: { name: 'slack' },
      channelId: 'slack-channel-1',
      id: 'slack-thread-1',
    },
    {
      id: 'slack-message-1',
      text: 'What did you mean?',
      raw: discordRawReply,
      author: {
        userId: 'user-1',
        userName: 'user',
        fullName: 'User',
        isBot: false,
        isMe: false,
      },
    },
  )

  assert.strictEqual(inbound.binding.platform, 'slack')
  assert.strictEqual(inbound.message.replyTo, undefined)
})

it('drops reply context for absent, deleted, or malformed referenced messages', () => {
  const author = {
    userId: 'user-1',
    userName: 'user',
    fullName: 'User',
    isBot: false,
    isMe: false,
  }
  const thread = {
    adapter: { name: 'discord' as const },
    channelId: 'discord-channel-1',
    id: 'discord-thread-1',
  }
  // Fixtures below with `type: 19` exercise nested defensive decoding and the
  // blank-content guard; those without exercise the missing/non-19 type gate.
  const raws = [
    {},
    { referenced_message: null },
    { type: 19, referenced_message: null },
    { type: 19, referenced_message: { id: 'm-0', content: 'gone', author: {} } },
    { type: 19, referenced_message: { id: 'm-0', content: 'gone', author: { id: '  ' } } },
    { type: 19, referenced_message: { id: '', content: 'gone', author: { id: 'user-0' } } },
    { type: 19, referenced_message: { id: 'm-0', author: { id: 'user-0' } } },
    { type: 19, referenced_message: { id: 'm-0', content: 42, author: { id: 'user-0' } } },
    { type: 19, referenced_message: { id: 'm-0', content: '   ', author: { id: 'user-0' } } },
    'not-an-object',
  ]
  for (const raw of raws) {
    const inbound = projectChatSdkMessage('discord', thread, {
      id: 'discord-message-1',
      text: 'Hello Friday',
      raw,
      author,
    })
    assert.strictEqual(inbound.message.replyTo, undefined, JSON.stringify(raw))
  }
})

it('projects attributed context messages', () => {
  const context = projectChatSdkContextMessage('discord', {
    id: 'discord-message-2',
    text: 'Earlier message',
    author: {
      userId: 'user-2',
      userName: 'alice',
      fullName: 'Alice',
      isBot: false,
      isMe: false,
    },
  })

  assert.strictEqual(context.author.mention, '<@user-2>')
  assert.strictEqual(context.content.text, 'Earlier message')
  assert.strictEqual(String(context.platformMessageId), 'discord-message-2')
})
