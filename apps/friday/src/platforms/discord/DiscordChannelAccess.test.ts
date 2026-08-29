import { assert, it } from '@effect/vitest'

import { discordRespondToChannelIds } from './DiscordChannelAccess.ts'

it('adapts all mode to the Discord SDK channel contract', () => {
  const channels = discordRespondToChannelIds({ mode: 'all', ids: [] })
  assert(channels.length > 0)
  assert.strictEqual(channels.includes('any-channel'), true)
})

it('adapts allow mode to explicit channel identifiers', () => {
  const channels = discordRespondToChannelIds({ mode: 'allow', ids: ['channel-1'] })
  assert.strictEqual(channels.length, 1)
  assert.strictEqual(channels.includes('channel-1'), true)
  assert.strictEqual(channels.includes('channel-2'), false)
})

it('adapts deny mode to every channel except blocked identifiers', () => {
  const channels = discordRespondToChannelIds({ mode: 'deny', ids: ['channel-1'] })
  assert(channels.length > 0)
  assert.strictEqual(channels.includes('channel-1'), false)
  assert.strictEqual(channels.includes('channel-2'), true)
})
