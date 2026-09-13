import { assert, it } from '@effect/vitest'

import { projectSlackMessage } from './SlackMessageProjection.ts'

it('binds channel roots to the channel conversation', () => {
  const input = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.111111',
    userId: 'U789',
    username: 'chan',
    displayName: 'Chan',
    text: 'hey <@UBOT> help with deploys',
  })
  assert.strictEqual(input.binding.platform, 'slack')
  assert.strictEqual(String(input.binding.channelId), 'slack:T123:C456')
  assert.strictEqual(String(input.binding.conversationId), 'slack:T123:C456')
  assert.strictEqual(String(input.binding.sourceMessageId), '1234567890.111111')
  assert.strictEqual(input.binding.scopeId, 'T123')
  assert.strictEqual(input.historySource, 'channel')
  assert.strictEqual(input.discordHistorySource, 'channel')
  assert.strictEqual(input.message.content.text, 'hey <@UBOT> help with deploys')
  assert.deepStrictEqual(input.message.content.images, [])
  // Verbatim Slack author mention, never a resolved display name.
  assert.strictEqual(input.message.author?.mention, '<@U789>')
  assert.strictEqual(input.message.author?.platformUserId, 'U789')
  assert.strictEqual(input.message.source, 'user')
})

it('binds thread replies to the platform thread', () => {
  const input = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.222222',
    threadTs: '1234567890.111111',
    userId: 'U789',
    text: 'following up',
  })
  assert.strictEqual(String(input.binding.conversationId), 'slack:T123:C456:1234567890.111111')
  assert.strictEqual(String(input.binding.channelId), 'slack:T123:C456')
  assert.strictEqual(input.historySource, 'thread')
  assert.strictEqual(input.discordHistorySource, 'thread')
})

it('represents attached files as unsupported-attachment notices', () => {
  const input = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.333333',
    userId: 'U789',
    text: 'see attached',
    files: [{ name: 'screenshot.png', mimetype: 'image/png' }],
  })
  assert.ok(input.message.content.text.includes('see attached'))
  assert.ok(
    input.message.content.text.includes(
      '[Slack attachment unsupported: screenshot.png (image/png)]',
    ),
  )
  assert.deepStrictEqual(input.message.content.images, [])
})

it('collapses a blank thread timestamp to the channel root', () => {
  const input = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.555555',
    threadTs: '',
    userId: 'U789',
    text: 'top-level',
  })
  assert.strictEqual(String(input.binding.conversationId), 'slack:T123:C456')
  assert.strictEqual(input.historySource, 'channel')
})

it('names unnamed attachments instead of dropping them', () => {
  const missing = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.666666',
    userId: 'U789',
    text: '',
    files: [{ mimetype: 'application/pdf' }],
  })
  assert.strictEqual(
    missing.message.content.text,
    '[Slack attachment unsupported: unnamed attachment (application/pdf)]',
  )

  const blank = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.777777',
    userId: 'U789',
    text: '',
    files: [{ name: '   ', filetype: 'png' }],
  })
  assert.strictEqual(
    blank.message.content.text,
    '[Slack attachment unsupported: unnamed attachment (png)]',
  )
})

it('omits the detail when the attachment has no type info', () => {
  const input = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.999999',
    userId: 'U789',
    text: 'files',
    files: [{ name: 'notes.bin' }],
  })
  assert.strictEqual(input.message.content.text, 'files\n[Slack attachment unsupported: notes.bin]')
})

it('joins several attachment notices with newlines', () => {
  const input = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.888888',
    userId: 'U789',
    text: 'files',
    files: [
      { name: 'a.png', mimetype: 'image/png' },
      { name: 'b.png', mimetype: 'image/png' },
    ],
  })
  assert.strictEqual(
    input.message.content.text,
    [
      'files',
      '[Slack attachment unsupported: a.png (image/png)]',
      '[Slack attachment unsupported: b.png (image/png)]',
    ].join('\n'),
  )
})

it('keeps Slack mention text verbatim', () => {
  const input = projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.444444',
    userId: 'U789',
    text: '<@U111> and <!channel> and <!here>',
  })
  assert.strictEqual(input.message.content.text, '<@U111> and <!channel> and <!here>')
})
