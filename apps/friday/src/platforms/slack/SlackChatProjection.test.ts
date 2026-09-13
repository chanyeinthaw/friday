/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Test doubles mirror the adapter declared protected payload shapes; raw Slack events are decoded with Schema in projection. */
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { projectSlackChatMessage } from './SlackMessageProjection.ts'

const threadFor = (id: string, channelId: string) => ({
  id,
  channelId,
  adapter: { name: 'slack' },
})

const messageFor = (
  id: string,
  raw: Record<string, unknown>,
  overrides: Partial<{ readonly text: string; readonly isMention: boolean }> = {},
) => {
  const base = {
    id,
    text: 'converted-text',
    raw,
    author: { userId: 'U789', userName: 'chan', fullName: 'Chan', isBot: false, isMe: false },
  }
  if (overrides.isMention === undefined) return base
  return { ...base, isMention: overrides.isMention }
}

it.effect('collapses top-level channel messages to the channel root', () =>
  Effect.gen(function* () {
    const input = yield* projectSlackChatMessage(
      'slack-personal',
      threadFor('slack:C456:1234567890.111111', 'slack:C456'),
      messageFor('1234567890.111111', {
        channel: 'C456',
        team_id: 'T123',
        text: 'hey <@UBOT> help',
        ts: '1234567890.111111',
      }),
    )
    assert.strictEqual(String(input.binding.channelId), 'slack:T123:C456')
    assert.strictEqual(String(input.binding.conversationId), 'slack:T123:C456')
    assert.strictEqual(input.historySource, 'channel')
    assert.strictEqual(input.message.content.text, 'hey <@UBOT> help')
    assert.strictEqual(input.message.author?.mention, '<@U789>')
  }),
)

it.effect('binds threaded replies to the platform thread', () =>
  Effect.gen(function* () {
    const input = yield* projectSlackChatMessage(
      'slack-personal',
      threadFor('slack:C456:1234567890.111111', 'slack:C456'),
      messageFor('1234567890.222222', {
        channel: 'C456',
        team_id: 'T123',
        text: 'follow up',
        thread_ts: '1234567890.111111',
        ts: '1234567890.222222',
      }),
    )
    assert.strictEqual(String(input.binding.conversationId), 'slack:T123:C456:1234567890.111111')
    assert.strictEqual(input.historySource, 'thread')
  }),
)

it.effect('binds DMs to the DM channel root with unsupported file notices', () =>
  Effect.gen(function* () {
    const input = yield* projectSlackChatMessage(
      'slack-personal',
      threadFor('slack:D789:1234567890.333333', 'slack:D789'),
      {
        ...messageFor('1234567890.333333', {
          channel: 'D789',
          team_id: 'T123',
          text: 'see attached',
          ts: '1234567890.333333',
        }),
        attachments: [{ type: 'image', name: 'screenshot.png', mimeType: 'image/png' }],
      },
    )
    assert.strictEqual(String(input.binding.conversationId), 'slack:T123:D789')
    assert.ok(input.message.content.text.includes('see attached'))
    assert.ok(
      input.message.content.text.includes(
        '[Slack attachment unsupported: screenshot.png (image/png)]',
      ),
    )
  }),
)

it.effect('reads the team from string and object shapes', () =>
  Effect.gen(function* () {
    const fromString = yield* projectSlackChatMessage(
      'slack-personal',
      threadFor('slack:C456:1234567890.111111', 'slack:C456'),
      messageFor('1234567890.111111', {
        channel: 'C456',
        team: 'T123',
        text: 'hey',
        ts: '1234567890.111111',
      }),
    )
    assert.strictEqual(String(fromString.binding.conversationId), 'slack:T123:C456')
    assert.strictEqual(fromString.binding.scopeId, 'T123')

    const fromObject = yield* projectSlackChatMessage(
      'slack-personal',
      threadFor('slack:C456:1234567890.111111', 'slack:C456'),
      messageFor('1234567890.111111', {
        channel: 'C456',
        team: { id: 'T123' },
        text: 'hey',
        ts: '1234567890.111111',
      }),
    )
    assert.strictEqual(String(fromObject.binding.conversationId), 'slack:T123:C456')
    assert.strictEqual(fromObject.binding.scopeId, 'T123')
  }),
)

it.effect('prefers the raw channel over the adapter thread', () =>
  Effect.gen(function* () {
    const input = yield* projectSlackChatMessage(
      'slack-personal',
      threadFor('slack:C456:1234567890.111111', 'slack:C456'),
      messageFor('1234567890.111111', {
        channel: 'C999',
        team_id: 'T123',
        text: 'hey',
        ts: '1234567890.111111',
      }),
    )
    assert.strictEqual(String(input.binding.channelId), 'slack:T123:C999')
  }),
)

it.effect('fails when the raw channel is blank and the adapter id is foreign', () =>
  Effect.gen(function* () {
    const result = yield* Effect.flip(
      projectSlackChatMessage(
        'slack-personal',
        threadFor('foreign-thread', 'foreign-channel'),
        messageFor('1234567890.666666', { team_id: 'T123', text: 'hey' }),
      ),
    )
    assert.strictEqual(result._tag, 'ChatSdkCallbackError')
  }),
)

it.effect('fails when the raw payload is absent', () =>
  Effect.gen(function* () {
    const result = yield* Effect.flip(
      projectSlackChatMessage('slack-personal', threadFor('slack:C456:', 'slack:C456'), {
        id: '1234567890.555555',
        text: 'converted-text',
        raw: undefined,
        author: { userId: 'U789', userName: 'chan', fullName: 'Chan', isBot: false, isMe: false },
      }),
    )
    assert.strictEqual(result._tag, 'ChatSdkCallbackError')
  }),
)

it.effect('fails when team or channel is missing', () =>
  Effect.gen(function* () {
    const result = yield* Effect.flip(
      projectSlackChatMessage(
        'slack-personal',
        threadFor('slack:C456:', 'slack:C456'),
        messageFor('1234567890.444444', { text: 'no scope' }),
      ),
    )
    assert.strictEqual(result._tag, 'ChatSdkCallbackError')
  }),
)
