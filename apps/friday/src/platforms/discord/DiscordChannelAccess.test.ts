import { assert, it } from '@effect/vitest'
import * as Option from 'effect/Option'

import type { AccessPolicy } from '../../config/AppConfig.ts'
import {
  makeDiscordInvocationChannelSelector,
  makeDiscordLocationGate,
  type DiscordConnectionPolicies,
} from './DiscordChannelAccess.ts'

const makePolicies = (
  overrides: Partial<DiscordConnectionPolicies> = {},
): DiscordConnectionPolicies => ({
  guilds: { mode: 'all', ids: [] },
  channels: { mode: 'all', ids: [] },
  users: { mode: 'all', ids: [] },
  invocation: { defaultMode: 'mention-only', channels: [] },
  systemChannelIds: [],
  ...overrides,
})

it('selects all-message channels while leaving mention-only channels to mention routing', () => {
  const selector = makeDiscordInvocationChannelSelector(() =>
    Option.some(
      makePolicies({
        invocation: {
          defaultMode: 'mention-only',
          channels: [{ channelId: 'channel-1', mode: 'all-messages' }],
        },
      }),
    ),
  )
  assert(selector.channels.length > 0)
  assert.strictEqual(selector.channels.includes('channel-1'), true)
  assert.strictEqual(selector.channels.includes('channel-2'), false)
})

it('reads invocation routing live from the policy provider without replacing the selector', () => {
  let invocation: DiscordConnectionPolicies['invocation'] = {
    defaultMode: 'mention-only',
    channels: [],
  }
  const selector = makeDiscordInvocationChannelSelector(() =>
    Option.some(makePolicies({ invocation })),
  )
  const channels = selector.channels
  assert.strictEqual(channels.includes('channel-1'), false)
  invocation = {
    defaultMode: 'mention-only',
    channels: [{ channelId: 'channel-1', mode: 'all-messages' }],
  }
  assert.strictEqual(selector.channels, channels)
  assert.strictEqual(channels.includes('channel-1'), true)
})

it('never selects channels rejected by access policy', () => {
  const selector = makeDiscordInvocationChannelSelector(() =>
    Option.some(
      makePolicies({
        channels: { mode: 'deny', ids: ['blocked'] } satisfies AccessPolicy,
        invocation: { defaultMode: 'all-messages', channels: [] },
      }),
    ),
  )
  assert.strictEqual(selector.channels.includes('allowed'), true)
  assert.strictEqual(selector.channels.includes('blocked'), false)
})

it('selects nothing when the connection is no longer running', () => {
  const selector = makeDiscordInvocationChannelSelector(() => Option.none())
  assert.strictEqual(selector.channels.includes('channel-1'), false)
})

it('allows locations only when both guild and channel pass their policies', () => {
  const gate = makeDiscordLocationGate(() =>
    Option.some(
      makePolicies({
        guilds: { mode: 'allow', ids: ['guild-1'] },
        channels: { mode: 'allow', ids: ['channel-1'] },
      }),
    ),
  )
  assert.strictEqual(gate('guild-1', 'channel-1'), true)
  assert.strictEqual(gate('guild-2', 'channel-1'), false)
  assert.strictEqual(gate('guild-1', 'channel-2'), false)
})

it('denies every location when the connection is no longer running', () => {
  const gate = makeDiscordLocationGate(() => Option.none())
  assert.strictEqual(gate('guild-1', 'channel-1'), false)
})

it('ignores guilds and channels omitted from an allow policy', () => {
  const gate = makeDiscordLocationGate(() =>
    Option.some(
      makePolicies({
        guilds: { mode: 'allow', ids: ['guild-1'] },
        channels: { mode: 'allow', ids: [] },
      }),
    ),
  )
  assert.strictEqual(gate('guild-1', 'channel-1'), false)
  assert.strictEqual(gate('guild-1', 'channel-2'), false)
})

it('keeps deny-policy and all-policy guild locations allowed', () => {
  const denyGate = makeDiscordLocationGate(() =>
    Option.some(
      makePolicies({
        guilds: { mode: 'deny', ids: ['blocked'] },
        channels: { mode: 'all', ids: [] },
      }),
    ),
  )
  assert.strictEqual(denyGate('guild-1', 'channel-1'), true)
  assert.strictEqual(denyGate('blocked', 'channel-1'), false)
  const allGate = makeDiscordLocationGate(() => Option.some(makePolicies()))
  assert.strictEqual(allGate('guild-1', 'channel-1'), true)
})
