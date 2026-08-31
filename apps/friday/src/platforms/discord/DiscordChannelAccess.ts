import * as Option from 'effect/Option'

import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import type { AccessPolicy, DiscordPlatformConfig } from '../../config/AppConfig.ts'
import { effectiveInvocationMode } from '../InvocationPolicies.ts'

/** Live view of a Discord connection's reloadable policy section. */
export interface DiscordConnectionPolicies {
  readonly guilds: AccessPolicy
  readonly channels: AccessPolicy
  readonly users: AccessPolicy
  readonly invocation: DiscordPlatformConfig['invocation']
  readonly systemChannelIds: ReadonlyArray<string>
}

/**
 * Synchronous provider for the current reloadable policies of one Discord
 * connection. Backed by the in-memory configuration snapshot; returns None when
 * the connection is no longer running.
 */
export type DiscordPolicyProvider = () => Option.Option<DiscordConnectionPolicies>

const isAccessible = (channelId: string, policy: AccessPolicy): boolean => {
  if (policy.mode === 'all') return true
  if (policy.mode === 'allow') return policy.ids.includes(channelId)
  return !policy.ids.includes(channelId)
}

export interface DiscordInvocationChannelSelector {
  readonly channels: Array<string>
}

/**
 * Location gate for the Discord adapter: a message location is allowed only when
 * both the guild and the (parent) channel pass their access policies. Guilds and
 * channels without a configured policy are treated as allowed, matching the
 * `AccessPolicy` semantics used by Friday's message handlers. Policies are read
 * from the provider on every check so reloads apply without touching Discord
 * resources; a missing connection snapshot denies everything.
 */
export const makeDiscordLocationGate =
  (policies: DiscordPolicyProvider): ((guildId: string, channelId: string) => boolean) =>
  (guildId, channelId) =>
    Option.match(policies(), {
      onNone: () => false,
      onSome: (current) =>
        isAllowedByPolicy(guildId, current.guilds) &&
        isAllowedByPolicy(channelId, current.channels),
    })

/**
 * The Discord adapter only reads `length` and calls `includes(channelId)`.
 * Keep that stable adapter reference while the invocation and channel policies
 * are read live from the configuration snapshot on every check.
 */
export const makeDiscordInvocationChannelSelector = (
  policies: DiscordPolicyProvider,
): DiscordInvocationChannelSelector => ({
  channels: new Proxy([], {
    get: (_target, property) => {
      if (property === 'length') return 1
      if (property === 'includes') {
        return (channelId: string): boolean =>
          Option.match(policies(), {
            onNone: () => false,
            onSome: (current) => {
              if (!isAccessible(channelId, current.channels)) return false
              return effectiveInvocationMode(current.invocation, channelId) === 'all-messages'
            },
          })
      }
      return undefined
    },
  }),
})
