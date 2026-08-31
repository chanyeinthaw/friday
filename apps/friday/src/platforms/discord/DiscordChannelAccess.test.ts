import { assert, it } from '@effect/vitest'

import {
  makeDiscordInvocationChannelSelector,
  makeDiscordLocationGate,
} from './DiscordChannelAccess.ts'

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

it('allows locations only when both guild and channel pass their policies', () => {
  const gate = makeDiscordLocationGate(
    { mode: 'allow', ids: ['guild-1'] },
    { mode: 'allow', ids: ['channel-1'] },
  )
  assert.strictEqual(gate('guild-1', 'channel-1'), true)
  assert.strictEqual(gate('guild-2', 'channel-1'), false)
  assert.strictEqual(gate('guild-1', 'channel-2'), false)
})

it('ignores guilds and channels omitted from an allow policy', () => {
  const gate = makeDiscordLocationGate(
    { mode: 'allow', ids: ['guild-1'] },
    { mode: 'allow', ids: [] },
  )
  assert.strictEqual(gate('guild-1', 'channel-1'), false)
  assert.strictEqual(gate('guild-1', 'channel-2'), false)
})

it('keeps deny-policy and all-policy guild locations allowed', () => {
  const denyGate = makeDiscordLocationGate(
    { mode: 'deny', ids: ['blocked'] },
    { mode: 'all', ids: [] },
  )
  assert.strictEqual(denyGate('guild-1', 'channel-1'), true)
  assert.strictEqual(denyGate('blocked', 'channel-1'), false)
  const allGate = makeDiscordLocationGate({ mode: 'all', ids: [] }, { mode: 'all', ids: [] })
  assert.strictEqual(allGate('guild-1', 'channel-1'), true)
})
