import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import type { AccessPolicy, DiscordPlatformConfig } from '../../config/AppConfig.ts'

/**
 * Adapts Friday's channel policy to Chat SDK's `respondToChannelIds` contract.
 * The pinned Discord adapter only reads `length` and calls `includes(channelId)`.
 */
const isAccessible = (channelId: string, policy: AccessPolicy): boolean => {
  if (policy.mode === 'all') return true
  if (policy.mode === 'allow') return policy.ids.includes(channelId)
  return !policy.ids.includes(channelId)
}

export interface DiscordInvocationChannelSelector {
  readonly channels: Array<string>
  readonly update: (invocation: DiscordPlatformConfig['invocation']) => void
}

/**
 * Location gate for the Discord adapter: a message location is allowed only when
 * both the guild and the (parent) channel pass their access policies. Guilds and
 * channels without a configured policy are treated as allowed, matching the
 * `AccessPolicy` semantics used by Friday's message handlers.
 */
export const makeDiscordLocationGate =
  (
    guilds: AccessPolicy,
    channels: AccessPolicy,
  ): ((guildId: string, channelId: string) => boolean) =>
  (guildId, channelId) =>
    isAllowedByPolicy(guildId, guilds) && isAllowedByPolicy(channelId, channels)

/**
 * The Discord adapter only reads `length` and calls `includes(channelId)`.
 * Keep that stable adapter reference while Friday refreshes database policy.
 */
export const makeDiscordInvocationChannelSelector = (
  access: AccessPolicy,
  initial: DiscordPlatformConfig['invocation'],
): DiscordInvocationChannelSelector => {
  let invocation = initial
  return {
    channels: new Proxy([], {
      get: (_target, property) => {
        if (property === 'length') return 1
        if (property === 'includes') {
          return (channelId: string) => {
            if (!isAccessible(channelId, access)) return false
            const mode =
              invocation.channels.find((policy) => policy.channelId === channelId)?.mode ??
              invocation.defaultMode
            return mode === 'all-messages'
          }
        }
        return undefined
      },
    }),
    update: (next) => {
      invocation = next
    },
  }
}
