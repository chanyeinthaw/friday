import { assert, it } from '@effect/vitest'
import { ImageAttachment } from '@friday/contracts/conversation'
import * as Schema from 'effect/Schema'

import { projectChatSdkContextMessage, projectChatSdkMessage } from './MessageProjection.ts'

const decodeImage = Schema.decodeSync(ImageAttachment)

const image = {
  id: 'attachment-1',
  filename: 'diagram.png',
  content_type: 'image/png',
  size: 1234,
  url: 'https://cdn.discordapp.com/attachments/channel/attachment/diagram.png',
}

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

it('projects the platform scope for Discord guilds and Slack workspaces', () => {
  const discord = projectChatSdkMessage(
    'discord',
    {
      adapter: { name: 'discord' },
      channelId: 'discord:guild-1:channel-1',
      id: 'discord:guild-1:channel-1:thread-1',
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
  assert.strictEqual(discord.binding.scopeId, 'guild-1')

  const slack = projectChatSdkMessage(
    'slack',
    {
      adapter: { name: 'slack' },
      channelId: 'slack:C123',
      id: 'slack:C123:1710000000.000000',
    },
    {
      id: '1710000000.000000',
      text: 'Hello Friday',
      raw: { team_id: 'T123' },
      author: {
        userId: 'U123',
        userName: 'user',
        fullName: 'User',
        isBot: false,
        isMe: false,
      },
    },
  )
  assert.strictEqual(slack.binding.scopeId, 'T123')

  const dm = projectChatSdkMessage(
    'discord',
    {
      adapter: { name: 'discord' },
      channelId: 'discord:@me:channel-1',
      id: 'discord:@me:channel-1',
    },
    {
      id: 'discord-dm-message-1',
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
  assert.isUndefined(dm.binding.scopeId)
})

it('projects Slack scope from string, object, and missing team shapes', () => {
  const slackAuthor = {
    userId: 'U123',
    userName: 'user',
    fullName: 'User',
    isBot: false,
    isMe: false,
  }
  const slackThread = {
    adapter: { name: 'slack' },
    channelId: 'slack:C123',
    id: 'slack:C123:1710000000.000000',
  }

  const fromStringTeam = projectChatSdkMessage('slack', slackThread, {
    id: '1710000000.000001',
    text: 'Hello Friday',
    raw: { team: 'T123' },
    author: slackAuthor,
  })
  assert.strictEqual(fromStringTeam.binding.scopeId, 'T123')

  const fromObjectTeam = projectChatSdkMessage('slack', slackThread, {
    id: '1710000000.000002',
    text: 'Hello Friday',
    raw: { team: { id: 'T123' } },
    author: slackAuthor,
  })
  assert.strictEqual(fromObjectTeam.binding.scopeId, 'T123')

  const withoutTeam = projectChatSdkMessage('slack', slackThread, {
    id: '1710000000.000003',
    text: 'Hello Friday',
    raw: {},
    author: slackAuthor,
  })
  assert.isUndefined(withoutTeam.binding.scopeId)

  // A non-object raw payload carries no team and never throws.
  const malformed = projectChatSdkMessage('slack', slackThread, {
    id: '1710000000.000004',
    text: 'Hello Friday',
    raw: 'unexpected',
    author: slackAuthor,
  })
  assert.isUndefined(malformed.binding.scopeId)
})

it('projects Discord trigger attachments, including image-only input', () => {
  const inbound = projectChatSdkMessage(
    'discord',
    {
      adapter: { name: 'discord' },
      channelId: 'discord-channel-1',
      id: 'discord-thread-1',
    },
    {
      id: 'discord-message-1',
      text: '',
      raw: { attachments: [image] },
      author: {
        userId: 'user-1',
        userName: 'user',
        fullName: 'User',
        isBot: false,
        isMe: false,
      },
    },
  )

  assert.strictEqual(inbound.message.content.text, '')
  assert.deepStrictEqual(inbound.message.content.images, [
    decodeImage({
      id: 'attachment-1',
      name: 'diagram.png',
      mediaType: 'image/png',
      sizeBytes: 1234,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/diagram.png',
    }),
  ])
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

it('projects attachment-only Discord reply targets', () => {
  const inbound = projectChatSdkMessage(
    'discord',
    {
      adapter: { name: 'discord' },
      channelId: 'discord-channel-1',
      id: 'discord-thread-1',
    },
    {
      id: 'discord-message-1',
      text: 'What is this?',
      raw: {
        type: 19,
        referenced_message: {
          id: 'discord-message-0',
          author: { id: 'user-0', username: 'bob', global_name: 'Bob' },
          attachments: [image],
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

  assert.deepStrictEqual(inbound.message.replyTo?.content, {
    text: '',
    images: [
      decodeImage({
        id: 'attachment-1',
        name: 'diagram.png',
        mediaType: 'image/png',
        sizeBytes: 1234,
        storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/diagram.png',
      }),
    ],
  })
})

it('keeps malformed, unavailable, and unsupported Discord attachments non-fatal', () => {
  const context = projectChatSdkContextMessage('discord', {
    id: 'discord-message-2',
    text: '',
    raw: {
      attachments: [
        { ...image, url: null },
        { ...image, id: 'attachment-2', filename: 'archive.zip', content_type: 'application/zip' },
        { filename: 'broken.png' },
      ],
    },
    author: {
      userId: 'user-2',
      userName: 'alice',
      fullName: 'Alice',
      isBot: false,
      isMe: false,
    },
  })

  assert.deepStrictEqual(context.content.images, [])
  assert.strictEqual(
    context.content.text,
    '[Discord attachment unavailable: diagram.png]\n' +
      '[Discord attachment unsupported: archive.zip (application/zip)]\n' +
      '[Discord attachment metadata malformed: unnamed attachment]',
  )
})

it('projects every supported text extension from raw Discord payloads', () => {
  const context = projectChatSdkContextMessage('discord', {
    id: 'discord-message-3',
    text: 'see files',
    raw: {
      attachments: [
        {
          id: 'html-1',
          filename: 'page.html',
          content_type: 'application/octet-stream',
          size: 100,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/page.html',
        },
        {
          id: 'htm-1',
          filename: 'PAGE.HTM',
          content_type: 'application/octet-stream',
          size: 110,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/PAGE.HTM',
        },
        {
          id: 'md-1',
          filename: 'NOTES.MD',
          content_type: 'application/octet-stream',
          size: 200,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/NOTES.MD',
        },
        {
          id: 'markdown-1',
          filename: 'Notes.Markdown',
          content_type: 'application/octet-stream',
          size: 210,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/Notes.Markdown',
        },
        {
          id: 'txt-1',
          filename: 'README.TXT',
          content_type: 'application/octet-stream',
          size: 300,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/README.TXT',
        },
      ],
    },
    author: {
      userId: 'user-2',
      userName: 'alice',
      fullName: 'Alice',
      isBot: false,
      isMe: false,
    },
  })

  assert.strictEqual(context.content.text, 'see files')
  assert.deepStrictEqual(context.content.images, [
    decodeImage({
      id: 'html-1',
      name: 'page.html',
      mediaType: 'application/octet-stream',
      sizeBytes: 100,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/page.html',
    }),
    decodeImage({
      id: 'htm-1',
      name: 'PAGE.HTM',
      mediaType: 'application/octet-stream',
      sizeBytes: 110,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/PAGE.HTM',
    }),
    decodeImage({
      id: 'md-1',
      name: 'NOTES.MD',
      mediaType: 'application/octet-stream',
      sizeBytes: 200,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/NOTES.MD',
    }),
    decodeImage({
      id: 'markdown-1',
      name: 'Notes.Markdown',
      mediaType: 'application/octet-stream',
      sizeBytes: 210,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/Notes.Markdown',
    }),
    decodeImage({
      id: 'txt-1',
      name: 'README.TXT',
      mediaType: 'application/octet-stream',
      sizeBytes: 300,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/README.TXT',
    }),
  ])
})

it('supports attachments by MIME type regardless of file extension', () => {
  const context = projectChatSdkContextMessage('discord', {
    id: 'discord-message-4',
    text: '',
    raw: {
      attachments: [
        {
          id: 'mime-1',
          filename: 'report.bin',
          content_type: 'Text/HTML; charset=utf-8',
          size: 100,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/report.bin',
        },
        {
          id: 'mime-2',
          filename: 'notes.bin',
          content_type: 'text/markdown',
          size: 200,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/notes.bin',
        },
        {
          id: 'mime-3',
          filename: 'readme.bin',
          content_type: 'text/plain',
          size: 300,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/readme.bin',
        },
      ],
    },
    author: {
      userId: 'user-2',
      userName: 'alice',
      fullName: 'Alice',
      isBot: false,
      isMe: false,
    },
  })

  assert.strictEqual(context.content.text, '')
  assert.deepStrictEqual(context.content.images, [
    decodeImage({
      id: 'mime-1',
      name: 'report.bin',
      mediaType: 'Text/HTML; charset=utf-8',
      sizeBytes: 100,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/report.bin',
    }),
    decodeImage({
      id: 'mime-2',
      name: 'notes.bin',
      mediaType: 'text/markdown',
      sizeBytes: 200,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/notes.bin',
    }),
    decodeImage({
      id: 'mime-3',
      name: 'readme.bin',
      mediaType: 'text/plain',
      sizeBytes: 300,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/readme.bin',
    }),
  ])
})

it('keeps representative unsupported files as notices', () => {
  const context = projectChatSdkContextMessage('discord', {
    id: 'discord-message-5',
    text: 'files',
    raw: {
      attachments: [
        {
          id: 'pdf-1',
          filename: 'paper.pdf',
          content_type: 'application/pdf',
          size: 400,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/paper.pdf',
        },
        {
          id: 'zip-1',
          filename: 'archive.zip',
          content_type: 'application/zip',
          size: 500,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/archive.zip',
        },
        {
          id: 'mp4-1',
          filename: 'clip.mp4',
          content_type: 'video/mp4',
          size: 600,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/clip.mp4',
        },
      ],
    },
    author: {
      userId: 'user-2',
      userName: 'alice',
      fullName: 'Alice',
      isBot: false,
      isMe: false,
    },
  })

  assert.deepStrictEqual(context.content.images, [])
  assert.strictEqual(
    context.content.text,
    'files\n' +
      '[Discord attachment unsupported: paper.pdf (application/pdf)]\n' +
      '[Discord attachment unsupported: archive.zip (application/zip)]\n' +
      '[Discord attachment unsupported: clip.mp4 (video/mp4)]',
  )
})

it('projects every supported text extension from history metadata', () => {
  const context = projectChatSdkContextMessage('discord', {
    id: 'discord-message-6',
    text: 'history',
    author: {
      userId: 'user-2',
      userName: 'alice',
      fullName: 'Alice',
      isBot: false,
      isMe: false,
    },
    attachments: [
      {
        type: 'file',
        name: 'PAGE.HTML',
        mimeType: 'application/octet-stream',
        size: 100,
        url: 'https://cdn.discordapp.com/attachments/channel/attachment/PAGE.HTML',
      },
      {
        type: 'file',
        name: 'page.htm',
        mimeType: 'application/octet-stream',
        size: 110,
        url: 'https://cdn.discordapp.com/attachments/channel/attachment/page.htm',
      },
      {
        type: 'file',
        name: 'notes.md',
        mimeType: 'application/octet-stream',
        size: 200,
        url: 'https://cdn.discordapp.com/attachments/channel/attachment/notes.md',
      },
      {
        type: 'file',
        name: 'NOTES.MARKDOWN',
        mimeType: 'application/octet-stream',
        size: 210,
        url: 'https://cdn.discordapp.com/attachments/channel/attachment/NOTES.MARKDOWN',
      },
      {
        type: 'file',
        name: 'readme.txt',
        mimeType: 'application/octet-stream',
        size: 300,
        url: 'https://cdn.discordapp.com/attachments/channel/attachment/readme.txt',
      },
    ],
  })

  assert.strictEqual(context.content.text, 'history')
  assert.deepStrictEqual(context.content.images, [
    decodeImage({
      id: 'attachment-discord-message-6-1',
      name: 'PAGE.HTML',
      mediaType: 'application/octet-stream',
      sizeBytes: 100,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/PAGE.HTML',
    }),
    decodeImage({
      id: 'attachment-discord-message-6-2',
      name: 'page.htm',
      mediaType: 'application/octet-stream',
      sizeBytes: 110,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/page.htm',
    }),
    decodeImage({
      id: 'attachment-discord-message-6-3',
      name: 'notes.md',
      mediaType: 'application/octet-stream',
      sizeBytes: 200,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/notes.md',
    }),
    decodeImage({
      id: 'attachment-discord-message-6-4',
      name: 'NOTES.MARKDOWN',
      mediaType: 'application/octet-stream',
      sizeBytes: 210,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/NOTES.MARKDOWN',
    }),
    decodeImage({
      id: 'attachment-discord-message-6-5',
      name: 'readme.txt',
      mediaType: 'application/octet-stream',
      sizeBytes: 300,
      storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/readme.txt',
    }),
  ])
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
