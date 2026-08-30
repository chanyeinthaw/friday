import { assert, it } from '@effect/vitest'

import { makeDiscordInvocationChannelSelector } from './DiscordChannelAccess.ts'

it('selects all-message channels while leaving mention-only channels to mention routing', () => {
  const selector = makeDiscordInvocationChannelSelector(
    { mode: 'all', ids: [] },
    {
      defaultMode: 'mention-only',
      channels: [{ channelId: 'channel-1', mode: 'all-messages' }],
    },
  )
  assert(selector.channels.length > 0)
  assert.strictEqual(selector.channels.includes('channel-1'), true)
  assert.strictEqual(selector.channels.includes('channel-2'), false)
})

it('updates invocation routing without replacing the Discord adapter selector', () => {
  const selector = makeDiscordInvocationChannelSelector(
    { mode: 'all', ids: [] },
    { defaultMode: 'mention-only', channels: [] },
  )
  const channels = selector.channels
  assert.strictEqual(channels.includes('channel-1'), false)
  selector.update({
    defaultMode: 'mention-only',
    channels: [{ channelId: 'channel-1', mode: 'all-messages' }],
  })
  assert.strictEqual(selector.channels, channels)
  assert.strictEqual(channels.includes('channel-1'), true)
})

it('never selects channels rejected by access policy', () => {
  const selector = makeDiscordInvocationChannelSelector(
    { mode: 'deny', ids: ['blocked'] },
    { defaultMode: 'all-messages', channels: [] },
  )
  assert.strictEqual(selector.channels.includes('allowed'), true)
  assert.strictEqual(selector.channels.includes('blocked'), false)
})
