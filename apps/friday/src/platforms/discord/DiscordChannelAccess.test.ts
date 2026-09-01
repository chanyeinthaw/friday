import { assert, it } from '@effect/vitest'
import * as Option from 'effect/Option'

import type { AccessPolicy, DiscordGuildConfig } from '../../config/AppConfig.ts'

/** Mutable assembly shapes for fixtures carrying optional overrides only. */
interface GuildFixture {
  guildId: string
  enabled: boolean
  invocation: { defaultMode: 'mention-only' | 'all-messages' }
  users?: AccessPolicy
  channels: DiscordGuildConfig['channels']
}

interface ChannelFixture {
  channelId: string
  invocationMode?: 'mention-only' | 'all-messages'
  users?: AccessPolicy
  replyMode?: 'reply-in-thread' | 'reply-in-channel'
}
import {
  replyInChannelChannelIds,
  resolveDiscordChannelPolicy,
  shouldInvoke,
  type DiscordConnectionPolicies,
} from './DiscordChannelAccess.ts'

const guild = (
  overrides: {
    readonly guildId?: string
    readonly enabled?: boolean
    readonly invocationMode?: 'mention-only' | 'all-messages'
    readonly users?: AccessPolicy
    readonly channels?: DiscordGuildConfig['channels']
  } = {},
): DiscordGuildConfig => {
  const entry: GuildFixture = {
    guildId: overrides.guildId ?? '111111111111111111',
    enabled: overrides.enabled ?? true,
    invocation: { defaultMode: overrides.invocationMode ?? 'mention-only' },
    channels: overrides.channels ?? [],
  }
  if (overrides.users !== undefined) entry.users = overrides.users
  return entry
}

const channel = (
  overrides: {
    readonly channelId?: string
    readonly invocationMode?: 'mention-only' | 'all-messages'
    readonly users?: AccessPolicy
    readonly replyMode?: 'reply-in-thread' | 'reply-in-channel'
  } = {},
) => {
  const entry: ChannelFixture = {
    channelId: overrides.channelId ?? '222222222222222222',
  }
  if (overrides.invocationMode !== undefined) entry.invocationMode = overrides.invocationMode
  if (overrides.users !== undefined) entry.users = overrides.users
  if (overrides.replyMode !== undefined) entry.replyMode = overrides.replyMode
  return entry
}

const policies = (
  overrides: Partial<DiscordConnectionPolicies> = {},
): DiscordConnectionPolicies => ({
  users: { mode: 'all', ids: [] },
  guilds: [],
  ...overrides,
})

it('resolves nothing for unknown and disabled guilds', () => {
  const unknown = resolveDiscordChannelPolicy(
    policies({ guilds: [guild({ enabled: false })] }),
    '999999999999999999',
    '222222222222222222',
  )
  assert(Option.isNone(unknown))
  const disabled = resolveDiscordChannelPolicy(
    policies({ guilds: [guild({ enabled: false })] }),
    '111111111111111111',
    '222222222222222222',
  )
  assert(Option.isNone(disabled))
})

it('applies guild-wide defaults inside an enabled guild', () => {
  const users: AccessPolicy = { mode: 'allow', ids: ['333333333333333333'] }
  const resolved = resolveDiscordChannelPolicy(
    policies({
      users: { mode: 'deny', ids: [] },
      guilds: [guild({ invocationMode: 'all-messages', users })],
    }),
    '111111111111111111',
    '222222222222222222',
  )
  assert(Option.isSome(resolved))
  assert.strictEqual(resolved.value.invocationMode, 'all-messages')
  assert.strictEqual(resolved.value.replyMode, 'reply-in-thread')
  assert.deepStrictEqual(resolved.value.users, users)
})

it('invokes on mentions, direct messages, and all-messages channels', () => {
  // Mentions and direct messages always invoke.
  assert.strictEqual(
    shouldInvoke({ kind: 'mention', mode: 'mention-only', hasBinding: false }),
    true,
  )
  assert.strictEqual(
    shouldInvoke({ kind: 'direct-message', mode: 'mention-only', hasBinding: false }),
    true,
  )
  // Subscribed channel messages follow the invocation mode.
  assert.strictEqual(
    shouldInvoke({ kind: 'subscribed-message', mode: 'all-messages', hasBinding: false }),
    true,
  )
  assert.strictEqual(
    shouldInvoke({ kind: 'subscribed-message', mode: 'mention-only', hasBinding: false }),
    false,
  )
  // A persisted binding does not turn mention-only into all-messages.
  assert.strictEqual(
    shouldInvoke({ kind: 'subscribed-message', mode: 'mention-only', hasBinding: true }),
    false,
  )
})

it('resolves each guild by its own id, not the first configured one', () => {
  const resolved = resolveDiscordChannelPolicy(
    policies({
      users: { mode: 'allow', ids: ['333333333333333333'] },
      guilds: [
        guild({ invocationMode: 'all-messages' }),
        guild({ guildId: '666666666666666666', enabled: false }),
      ],
    }),
    '666666666666666666',
    '222222222222222222',
  )
  assert(Option.isNone(resolved))
})

it('layers channel overrides over guild defaults over the connection policy', () => {
  const guildUsers: AccessPolicy = { mode: 'allow', ids: ['333333333333333333'] }
  const channelUsers: AccessPolicy = { mode: 'deny', ids: ['444444444444444444'] }
  const resolved = resolveDiscordChannelPolicy(
    policies({
      users: { mode: 'all', ids: [] },
      guilds: [
        guild({
          invocationMode: 'all-messages',
          users: guildUsers,
          channels: [
            channel({ channelId: '222222222222222222', users: channelUsers }),
            // A channel entry carrying only a reply override must not touch
            // invocation or permissions; a second entry is matched by its own
            // id, never the first.
            channel({ channelId: '555555555555555555', replyMode: 'reply-in-channel' }),
          ],
        }),
      ],
    }),
    '111111111111111111',
    '222222222222222222',
  )
  assert(Option.isSome(resolved))
  assert.strictEqual(resolved.value.invocationMode, 'all-messages')
  assert.deepStrictEqual(resolved.value.users, channelUsers)
  assert.strictEqual(resolved.value.replyMode, 'reply-in-thread')

  const replyOnly = resolveDiscordChannelPolicy(
    policies({
      users: { mode: 'all', ids: [] },
      guilds: [
        guild({
          invocationMode: 'all-messages',
          users: guildUsers,
          channels: [
            channel({ channelId: '222222222222222222', users: channelUsers }),
            channel({ channelId: '555555555555555555', replyMode: 'reply-in-channel' }),
          ],
        }),
      ],
    }),
    '111111111111111111',
    '555555555555555555',
  )
  assert(Option.isSome(replyOnly))
  assert.strictEqual(replyOnly.value.invocationMode, 'all-messages')
  assert.deepStrictEqual(replyOnly.value.users, guildUsers)
  assert.strictEqual(replyOnly.value.replyMode, 'reply-in-channel')
})

it('inherits the connection user policy when neither guild nor channel configure one', () => {
  const connectionUsers: AccessPolicy = { mode: 'allow', ids: ['333333333333333333'] }
  const resolved = resolveDiscordChannelPolicy(
    policies({
      users: connectionUsers,
      guilds: [guild()],
    }),
    '111111111111111111',
    '222222222222222222',
  )
  assert(Option.isSome(resolved))
  assert.deepStrictEqual(resolved.value.users, connectionUsers)
})

it('treats direct messages as operational with connection-level permissions', () => {
  const users: AccessPolicy = { mode: 'allow', ids: ['333333333333333333'] }
  const resolved = resolveDiscordChannelPolicy(policies({ users }), '@me', '222222222222222222')
  assert(Option.isSome(resolved))
  assert.strictEqual(resolved.value.invocationMode, 'mention-only')
  assert.deepStrictEqual(resolved.value.users, users)
})

it('collects reply-in-channel overrides only from enabled guilds', () => {
  const ids = replyInChannelChannelIds(
    policies({
      guilds: [
        guild({
          channels: [
            channel({ channelId: '222222222222222222', replyMode: 'reply-in-channel' }),
            channel({ channelId: '555555555555555555', replyMode: 'reply-in-thread' }),
          ],
        }),
        guild({
          guildId: '666666666666666666',
          enabled: false,
          channels: [channel({ channelId: '777777777777777777', replyMode: 'reply-in-channel' })],
        }),
      ],
    }),
  )
  assert.deepStrictEqual([...ids], ['222222222222222222'])
})
