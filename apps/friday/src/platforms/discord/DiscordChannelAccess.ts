import * as Option from 'effect/Option'

import type { AccessPolicy, DiscordPlatformConfig } from '../../config/AppConfig.ts'
import { DefaultReplyMode } from '../../config/AppConfig.ts'
import type { ChatSdkInboundKind } from '../chat-sdk/ChatSdkLifecycle.ts'

/**
 * Whether a message invokes Friday: mentions and direct messages always do;
 * other messages invoke only when the resolved channel mode is all-messages.
 * Mention-only conversations recover bounded missed history on their next mention.
 */
export const shouldInvoke = (input: {
  readonly kind: ChatSdkInboundKind
  readonly mode: 'mention-only' | 'all-messages'
  readonly hasBinding: boolean
}): boolean =>
  input.kind === 'mention' || input.kind === 'direct-message' || input.mode === 'all-messages'

/** Live view of a Discord connection's reloadable policy section. */
export type DiscordConnectionPolicies = Pick<DiscordPlatformConfig, 'users' | 'guilds'>

/**
 * Synchronous provider for the current reloadable policies of one Discord
 * connection. Backed by the in-memory configuration snapshot; returns None when
 * the connection is no longer running.
 */
export type DiscordPolicyProvider = () => Option.Option<DiscordConnectionPolicies>

/** Everything the message path needs to know about one Discord location. */
export interface DiscordResolvedChannelPolicy {
  /** Invocation mode resolved from the channel override or the guild default. */
  readonly invocationMode: 'mention-only' | 'all-messages'
  /** Reply behavior resolved from the channel override or the default. */
  readonly replyMode: 'reply-in-thread' | 'reply-in-channel'
  /**
   * User permission resolved from the channel override, the guild default, or
   * the connection-wide policy.
   */
  readonly users: AccessPolicy
}

/**
 * Resolves the effective policy for one Discord location. A guild that is
 * absent from the configuration, or disabled, resolves to None: Friday takes no
 * action there. Direct messages (`@me`) resolve against the connection-wide
 * user policy only; they are always operational and always mention-invoked.
 *
 * Callers pass the parent channel for messages inside threads, so thread
 * messages resolve their policy from the parent channel while remaining bound
 * to the thread they already belong to.
 */
export const resolveDiscordChannelPolicy = (
  connection: DiscordConnectionPolicies,
  guildId: string,
  channelId: string,
): Option.Option<DiscordResolvedChannelPolicy> => {
  if (guildId === '@me') {
    return Option.some({
      invocationMode: 'mention-only',
      replyMode: DefaultReplyMode,
      users: connection.users,
    })
  }
  const guild = connection.guilds.find((candidate) => candidate.guildId === guildId)
  if (guild === undefined || !guild.enabled) return Option.none()
  const channel = guild.channels.find((candidate) => candidate.channelId === channelId)
  return Option.some({
    invocationMode: channel?.invocationMode ?? guild.invocation.defaultMode,
    replyMode: channel?.replyMode ?? DefaultReplyMode,
    users: channel?.users ?? guild.users ?? connection.users,
  })
}

/**
 * Channel IDs configured to reply directly in the channel. Discord channel IDs
 * are globally unique, so scanning the enabled guilds' explicit channel entries
 * is unambiguous; only channel entries can override the reply mode.
 */
export const replyInChannelChannelIds = (
  connection: DiscordConnectionPolicies,
): ReadonlyArray<string> =>
  connection.guilds
    .filter((guild) => guild.enabled)
    .flatMap((guild) =>
      guild.channels
        .filter((channel) => channel.replyMode === 'reply-in-channel')
        .map((channel) => channel.channelId),
    )
