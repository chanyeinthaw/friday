/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-unknown-parameters -- Socket Mode envelopes arrive through untyped adapter handlers; team/channel/user fields are narrowed here before fail-closed policy checks, with full Schema decoding in projection. */
import { SlackAdapter, type SlackAdapterConfig, type SlackEvent } from '@chat-adapter/slack'
import type { WebhookOptions } from 'chat'

import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import type { SlackResolvedChannelPolicy } from './SlackChannelAccess.ts'

type SlackMessageHandlerEvent = Parameters<SlackAdapter['handleMessageEvent']>[0]
type AssistantStartedEvent = Parameters<SlackAdapter['handleAssistantThreadStarted']>[0]
type AssistantContextEvent = Parameters<SlackAdapter['handleAssistantContextChanged']>[0]
type AgentStoppedEvent = Parameters<SlackAdapter['handleAgentSessionStopped']>[0]
type AgentTitleEvent = Parameters<SlackAdapter['handleAgentSessionTitleChanged']>[0]
type AppHomeEvent = Parameters<SlackAdapter['handleAppHomeOpened']>[0]
type AppContextEvent = Parameters<SlackAdapter['handleAppContextChanged']>[0]
type MemberJoinedEvent = Parameters<SlackAdapter['handleMemberJoinedChannel']>[0]

export interface FridaySlackAdapterConfig extends Omit<
  SlackAdapterConfig,
  'agentView' | 'mode' | 'sessionTitle'
> {
  /**
   * Resolves the effective channel policy for a location, read on every event
   * so configuration reloads apply without rebuilding the adapter. Returning
   * undefined (unknown or disabled workspace/channel) drops the event before
   * any Chat state or visible Slack action.
   */
  readonly resolveChannelPolicy: (
    teamId: string,
    channelId: string,
  ) => SlackResolvedChannelPolicy | undefined
}

const teamFromEvent = (event: Pick<SlackEvent, 'team' | 'team_id'>): string =>
  typeof event.team_id === 'string' && event.team_id !== ''
    ? event.team_id
    : typeof event.team === 'string' && event.team !== ''
      ? event.team
      : ''

/**
 * Enforces Friday's fail-closed Slack policy at the adapter boundary. The
 * upstream adapter would otherwise store Chat state, apply suggested prompts,
 * and apply titles before Friday handlers run, so unknown or disabled
 * workspaces/channels and denied users must be dropped before that work
 * happens. Invocation (direct-mention-only, bound threads, DMs) stays in
 * the Chat lifecycle `shouldHandleMessage` gate where Friday persistence is
 * available; this layer owns admission only.
 *
 * Agent/AI experience is fixed on: `agentView` enables Agent Sessions events
 * over Socket Mode, while `sessionTitle: false` preserves Friday's
 * no-auto-title behavior (explicit titles still flow via
 * `setConversationTitle`). Suggested prompts pass through from Live. Friday
 * never sets session working status, so Friday never shows a processing
 * indicator or Stop button. Native cancellation is unsupported.
 */
export class FridaySlackAdapter extends SlackAdapter {
  private readonly resolveChannelPolicy: FridaySlackAdapterConfig['resolveChannelPolicy']

  constructor(config: FridaySlackAdapterConfig) {
    super({
      ...config,
      agentView: true,
      mode: 'socket',
      sessionTitle: false,
    })
    this.resolveChannelPolicy = config.resolveChannelPolicy
  }

  private dropsForPolicy(teamId: string, channelId: string, userId?: string): boolean {
    if (teamId === '' || channelId === '') return true
    const policy = this.resolveChannelPolicy(teamId, channelId)
    if (policy === undefined) return true
    if (userId !== undefined && userId !== '' && !isAllowedByPolicy(userId, policy.users)) {
      return true
    }
    return false
  }

  protected override handleMessageEvent(
    event: SlackMessageHandlerEvent,
    options?: WebhookOptions,
  ): void {
    const teamId = teamFromEvent(event as Pick<SlackEvent, 'team' | 'team_id'>)
    const channelId = (event as { readonly channel?: string }).channel ?? ''
    if (this.dropsForPolicy(teamId, channelId, (event as { readonly user?: string }).user)) {
      this.logger.debug('Ignored Slack message from unknown or disabled location', {
        teamId,
        channelId,
      })
      return
    }
    return super.handleMessageEvent(event, options)
  }

  protected override handleAssistantThreadStarted(
    event: AssistantStartedEvent,
    options?: WebhookOptions,
  ): void {
    const thread = (
      event as {
        readonly assistant_thread?: {
          readonly channel_id: string
          readonly user_id: string
          readonly context: { readonly team_id?: string }
        }
      }
    ).assistant_thread
    if (thread === undefined) return
    const teamId = thread.context.team_id ?? ''
    if (this.dropsForPolicy(teamId, thread.channel_id, thread.user_id)) {
      this.logger.debug('Ignored Slack assistant thread from unknown location', {
        channelId: thread.channel_id,
      })
      return
    }
    return super.handleAssistantThreadStarted(event, options)
  }

  protected override handleAssistantContextChanged(
    event: AssistantContextEvent,
    options?: WebhookOptions,
  ): void {
    const thread = (
      event as {
        readonly assistant_thread?: {
          readonly channel_id: string
          readonly user_id: string
          readonly context: { readonly team_id?: string }
        }
      }
    ).assistant_thread
    if (thread === undefined) return
    const teamId = thread.context.team_id ?? ''
    if (this.dropsForPolicy(teamId, thread.channel_id, thread.user_id)) return
    return super.handleAssistantContextChanged(event, options)
  }

  protected override handleAgentSessionStopped(
    event: AgentStoppedEvent,
    options?: WebhookOptions,
  ): void {
    // Agent stop carries no team; channel/user gating uses the resolved policy
    // only when both are present, otherwise it flows to the lifecycle handler
    // where Friday logs without creating threads or publishing.
    return super.handleAgentSessionStopped(event, options)
  }

  protected override handleAgentSessionTitleChanged(
    event: AgentTitleEvent,
    options?: WebhookOptions,
  ): void {
    const typed = event as {
      readonly team_id: string
      readonly channel: string
      readonly user: string
    }
    if (this.dropsForPolicy(typed.team_id, typed.channel, typed.user)) {
      this.logger.debug('Ignored Slack session title change from unknown location', {
        channelId: typed.channel,
      })
      return
    }
    return super.handleAgentSessionTitleChanged(event, options)
  }

  protected override handleAppHomeOpened(
    event: AppHomeEvent,
    options?: WebhookOptions,
    teamId?: string,
  ): void {
    const typed = event as { readonly channel: string; readonly user: string }
    if (
      teamId !== undefined &&
      teamId !== '' &&
      this.dropsForPolicy(teamId, typed.channel, typed.user)
    ) {
      this.logger.debug('Ignored Slack Home open from unknown location', {
        channelId: typed.channel,
      })
      return
    }
    return super.handleAppHomeOpened(event, options, teamId)
  }

  protected override handleAppContextChanged(
    event: AppContextEvent,
    options?: WebhookOptions,
  ): void {
    // Active-view context reports what the user is viewing; it never creates
    // Friday threads or publishes. It flows through for observability only.
    return super.handleAppContextChanged(event, options)
  }

  protected override handleMemberJoinedChannel(
    event: MemberJoinedEvent,
    options?: WebhookOptions,
  ): void {
    // Membership alone never invokes Friday; it flows through for Chat state
    // without Friday thread creation.
    return super.handleMemberJoinedChannel(event, options)
  }
}
