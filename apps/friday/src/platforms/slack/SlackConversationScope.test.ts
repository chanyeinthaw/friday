import { assert, it } from '@effect/vitest'

import {
  decodeSlackConversationId,
  isSlackThread,
  slackCanonicalConversationId,
  slackChannelConversationId,
  slackChannelId,
  slackConversationId,
} from './SlackConversationScope.ts'

it('encodes channel roots without a thread timestamp', () => {
  assert.strictEqual(slackConversationId({ teamId: 'T123', channelId: 'C456' }), 'slack:T123:C456')
  assert.strictEqual(slackChannelId({ teamId: 'T123', channelId: 'C456' }), 'slack:T123:C456')
  assert.strictEqual(
    slackChannelConversationId({ teamId: 'T123', channelId: 'C456' }),
    'slack:T123:C456',
  )
})

it('encodes thread replies with the root thread timestamp', () => {
  const conversationId = slackConversationId({
    teamId: 'T123',
    channelId: 'C456',
    threadTs: '1234567890.123456',
  })
  assert.strictEqual(conversationId, 'slack:T123:C456:1234567890.123456')
  assert.strictEqual(
    slackChannelConversationId({ teamId: 'T123', channelId: 'C456' }),
    'slack:T123:C456',
  )
})

it('distinguishes threads from channel roots', () => {
  assert.strictEqual(isSlackThread({ teamId: 'T123', channelId: 'C456' }), false)
  assert.strictEqual(
    isSlackThread({ teamId: 'T123', channelId: 'C456', threadTs: '1234567890.123456' }),
    true,
  )
  assert.strictEqual(isSlackThread({ teamId: 'T123', channelId: 'C456', threadTs: '' }), false)
  assert.strictEqual(isSlackThread({ teamId: 'T123', channelId: 'C456', threadTs: '   ' }), false)
})

it('decodes channel and thread conversation ids', () => {
  assert.deepStrictEqual(decodeSlackConversationId('slack:T123:C456'), {
    teamId: 'T123',
    channelId: 'C456',
  })
  assert.deepStrictEqual(decodeSlackConversationId('slack:T123:C456:1234567890.123456'), {
    teamId: 'T123',
    channelId: 'C456',
    threadTs: '1234567890.123456',
  })
})

it('rejects foreign and malformed conversation ids', () => {
  assert.strictEqual(decodeSlackConversationId('discord:guild:channel'), undefined)
  assert.strictEqual(decodeSlackConversationId('slack:T123'), undefined)
  assert.strictEqual(decodeSlackConversationId('slack:T123:C456:ts:extra'), undefined)
  assert.strictEqual(decodeSlackConversationId('slack::C456'), undefined)
  assert.strictEqual(decodeSlackConversationId('slack:T123:'), undefined)
  assert.strictEqual(decodeSlackConversationId('slack:T123:C456:'), undefined)
})

it('canonicalizes thread and channel bindings', () => {
  assert.strictEqual(
    slackCanonicalConversationId('slack:T123:C456:1234567890.123456'),
    'slack:T123:C456:1234567890.123456',
  )
  assert.strictEqual(slackCanonicalConversationId('slack:T123:C456'), 'slack:T123:C456')
  assert.strictEqual(slackCanonicalConversationId('foreign-binding'), 'foreign-binding')
})
