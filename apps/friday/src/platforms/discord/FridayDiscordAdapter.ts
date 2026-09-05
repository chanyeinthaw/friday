import { DiscordAdapter, type DiscordAdapterConfig } from '@chat-adapter/discord'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'

/** Location and author fields of a discord.js gateway message needed for policy gating. */
const DiscordLocationSegments = Schema.Union([
  Schema.Tuple([Schema.Literal('discord'), Schema.String, Schema.String]),
  Schema.Tuple([Schema.Literal('discord'), Schema.String, Schema.String, Schema.String]),
])
const decodeDiscordLocationSegments = Schema.decodeUnknownResult(DiscordLocationSegments)

interface DiscordGatewayMessage {
  readonly guildId: string | null
  readonly channelId: string
  readonly author: {
    readonly id: string
  }
  readonly channel: {
    readonly isThread: () => boolean
    readonly parentId?: string | null
  }
}

export type FridayDiscordAdapterConfig = DiscordAdapterConfig & {
  /**
   * Resolves the effective channel policy for a location, read on every message
   * so configuration reloads apply without rebuilding the adapter. Returning
   * undefined (unknown or disabled guild) drops the message before any
   * externally visible action.
   */
  readonly resolveChannelPolicy: (
    guildId: string,
    channelId: string,
  ) => DiscordResolvedChannelPolicy | undefined
  /**
   * Channel IDs configured to reply directly in the channel, read on every
   * thread creation so configuration reloads apply without rebuilding the
   * adapter.
   */
  readonly replyInChannelChannelIds: () => ReadonlyArray<string>
}

/**
 * Enforces Friday's guild-scoped Discord policy at the adapter boundary. The
 * upstream adapter would otherwise create a Discord thread for every mention
 * before Chat SDK handlers run, so unknown or disabled guilds, denied users,
 * and mention-only channels must be resolved before that thread creation
 * happens. Reply-in-channel channels keep replies at channel scope instead of
 * creating a thread.
 */
export class FridayDiscordAdapter extends DiscordAdapter {
  private readonly resolveChannelPolicy: FridayDiscordAdapterConfig['resolveChannelPolicy']
  private readonly replyInChannelChannelIds: FridayDiscordAdapterConfig['replyInChannelChannelIds']

  constructor(config: FridayDiscordAdapterConfig) {
    super(config)
    this.resolveChannelPolicy = config.resolveChannelPolicy
    this.replyInChannelChannelIds = config.replyInChannelChannelIds
  }

  /** Live view of the channels whose replies stay in the channel itself. */
  protected get replyInChannelIdList(): ReadonlyArray<string> {
    return this.replyInChannelChannelIds()
  }

  protected override createDiscordThread(
    channelId: string,
    messageId: string,
  ): Promise<{ id: string; name: string }> {
    return this.replyInChannelIdList.includes(channelId)
      ? Promise.resolve({ id: channelId, name: channelId })
      : super.createDiscordThread(channelId, messageId)
  }

  /**
   * Explicit adaptive-routing thread creation that bypasses the
   * reply-in-channel suppression. Single awaited attempt with no retry and no
   * client-side timeout; callers log and continue in the parent channel only
   * when native creation fails. The underlying Discord POST is non-abortable,
   * so callers wait for its result rather than racing a timeout that could
   * orphan a late-created thread.
   */
  public createRoutedDiscordThread(
    channelId: string,
    messageId: string,
  ): Promise<{ id: string; name: string }> {
    return super.createDiscordThread(channelId, messageId)
  }

  /**
   * Guild gate for application commands (`/friday`, `/harness`): an interaction
   * from an unregistered or disabled guild is dropped before any handler runs,
   * so it can neither invoke configuration operations nor receive a Friday
   * response (Discord surfaces its own "no response" state). Direct messages
   * (`@me`) have no guild and stay operational.
   */
  protected override handleApplicationCommandInteraction(
    // SAFETY: The adapter's declared context shape is structural; the gate only
    // reads channelId before delegating the original arguments unchanged.
    context: Parameters<DiscordAdapter['handleApplicationCommandInteraction']>[0],
    initialResponseFlags?: Parameters<DiscordAdapter['handleApplicationCommandInteraction']>[1],
    options?: Parameters<DiscordAdapter['handleApplicationCommandInteraction']>[2],
  ): void {
    if (context !== null) {
      const decoded = decodeDiscordLocationSegments(context.channelId.split(':'))
      if (Result.isFailure(decoded)) {
        this.logger.debug('Ignored application command with unresolvable location', {
          channelId: context.channelId,
          command: context.command,
        })
        return
      }
      const [, guildId, channelId] = decoded.success
      if (guildId !== '@me' && this.resolveChannelPolicy(guildId, channelId) === undefined) {
        this.logger.debug('Ignored application command from unknown or disabled guild', {
          guildId,
          channelId: context.channelId,
          command: context.command,
        })
        return
      }
    }
    // SAFETY: the arguments are the adapter's own context/flags/options shapes;
    // the base class accepts exactly what it produced.
    return super.handleApplicationCommandInteraction(
      context as never,
      initialResponseFlags,
      options,
    )
  }

  protected override handleGatewayMessage(
    // SAFETY: The gateway dispatches discord.js messages; the gate only reads
    // location and author fields.
    message: DiscordGatewayMessage,
    isMentioned: boolean,
  ): Promise<void> {
    const guildId = message.guildId ?? '@me'
    // Mirror the upstream parent-channel resolution so thread messages resolve
    // their policy from the parent channel while staying in their thread.
    const parentChannelId = message.channel.isThread()
      ? (message.channel.parentId ?? message.channelId)
      : message.channelId
    const policy = this.resolveChannelPolicy(guildId, parentChannelId)
    if (policy === undefined) {
      this.logger.debug('Ignored message from unknown or disabled guild', {
        guildId: message.guildId,
        channelId: message.channelId,
      })
      return Promise.resolve()
    }
    if (!isAllowedByPolicy(message.author.id, policy.users)) {
      this.logger.debug('Ignored message from denied user', {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
      })
      return Promise.resolve()
    }
    // Direct messages route through Chat's DM handling and never need an
    // adapter-side thread; guild messages invoke on mention or when the
    // resolved policy subscribes the whole channel.
    const invoke = guildId !== '@me' && (isMentioned || policy.invocationMode === 'all-messages')
    // SAFETY: the gateway dispatches discord.js messages; only the fields of
    // DiscordGatewayMessage above are read, and the base class accepts the same
    // message shape it dispatched.
    return super.handleGatewayMessage(message as never, invoke)
  }
}
