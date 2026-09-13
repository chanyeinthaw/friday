import * as Option from 'effect/Option'

import type { AccessPolicy, InvocationMode, ReplyMode } from '../../config/AppConfig.ts'
import { DefaultReplyMode, DefaultSlackInvocationMode } from '../../config/AppConfig.ts'
import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'

/**
 * Live view of a Slack connection's reloadable policy section. The access
 * triple is fail-closed: workspaces gate the team, channels gate the channel,
 * and users gate the author. Reply and invocation behavior resolve from the
 * per-channel overrides or the connection defaults.
 */
export interface SlackConnectionPolicies {
  readonly access: {
    readonly users: AccessPolicy
    readonly channels: AccessPolicy
    readonly workspaces: AccessPolicy
  }
  readonly defaultReplyMode: ReplyMode
  readonly channels: ReadonlyArray<{
    readonly channelId: string
    readonly invocationMode?: InvocationMode
    readonly replyMode?: ReplyMode
  }>
}

/**
 * Synchronous provider for the current reloadable policies of one Slack
 * connection. Backed by the in-memory configuration snapshot; returns None
 * when the connection is no longer running.
 */
export type SlackPolicyProvider = () => Option.Option<SlackConnectionPolicies>

/** Everything the message path needs to know about one Slack location. */
export interface SlackResolvedChannelPolicy {
  /**
   * Invocation behavior resolved from the channel override or the
   * mention-only default. `all-messages` admits channel and thread messages
   * without a direct mention, matching Discord; `mention-only` thread
   * replies still need a mention or a bound thread.
   */
  readonly invocationMode: InvocationMode
  /** Reply behavior resolved from the channel override or the connection default. */
  readonly replyMode: 'reply-in-thread' | 'reply-in-channel'
  /** Connection-wide user policy; channel-specific user overrides are not modeled. */
  readonly users: AccessPolicy
}

/**
 * Resolves the effective policy for one Slack location. Fail-closed: a team
 * outside the workspace scope or a channel outside the channel scope resolves
 * to None and Friday takes no action there. Per-channel rows only override
 * reply and invocation behavior; they never grant admission.
 */
export const resolveSlackChannelPolicy = (
  connection: SlackConnectionPolicies,
  teamId: string,
  channelId: string,
): Option.Option<SlackResolvedChannelPolicy> => {
  if (!isAllowedByPolicy(teamId, connection.access.workspaces)) return Option.none()
  if (!isAllowedByPolicy(channelId, connection.access.channels)) return Option.none()
  const override = connection.channels.find((candidate) => candidate.channelId === channelId)
  return Option.some({
    invocationMode: override?.invocationMode ?? DefaultSlackInvocationMode,
    replyMode: override?.replyMode ?? connection.defaultReplyMode ?? DefaultReplyMode,
    users: connection.access.users,
  })
}

/** Channel IDs configured to reply directly in the channel. */
export const replyInChannelSlackChannelIds = (
  connection: SlackConnectionPolicies,
): ReadonlyArray<string> =>
  connection.channels
    .filter((channel) => channel.replyMode === 'reply-in-channel')
    .map((channel) => channel.channelId)

/** Whether a Slack channel id addresses a direct message (IM) conversation. */
export const isSlackDirectMessageChannel = (channelId: string): boolean => channelId.startsWith('D')

/**
 * Whether a Slack message invokes Friday. Direct messages always invoke;
 * messages in an already-bound thread continue (or steer the active turn);
 * channel messages invoke on a direct bot mention, or without one when the
 * resolved channel mode is `all-messages` — including user-created native
 * thread replies, which start or continue a separate Friday thread bound to
 * `slack:{team}:{channel}:{threadTs}`, matching Discord's manual-thread
 * behavior. `@channel`, `@here`, and user-group mentions never invoke; in
 * an `all-messages` channel the containing message invokes because of the
 * channel mode, not the mention.
 */
export const shouldInvokeSlack = (input: {
  readonly isDirectMessage: boolean
  readonly hasBinding: boolean
  readonly isDirectMention: boolean
  readonly invocationMode?: InvocationMode
}): boolean =>
  input.isDirectMessage ||
  input.hasBinding ||
  input.isDirectMention ||
  (input.invocationMode ?? DefaultSlackInvocationMode) === 'all-messages'

/**
 * Detects a direct bot mention in Slack message text. Slack encodes mentions
 * verbatim as `<@U...>`; broadcast mentions (`<!channel>`, `<!here>`) and
 * user-group mentions (`<!subteam^...>`) never match this shape.
 */
export const containsDirectMention = (text: string, botUserId: string): boolean =>
  botUserId !== '' && text.includes(`<@${botUserId}>`)
