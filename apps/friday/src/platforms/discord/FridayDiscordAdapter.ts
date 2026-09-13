import { DiscordAdapter, type DiscordAdapterConfig } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import type { DiscordPresence } from './DiscordAgentActivity.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'

/** Location and author fields of a discord.js gateway message needed for policy gating. */
const DiscordLocationSegments = Schema.Union([
  Schema.Tuple([Schema.Literal('discord'), Schema.String, Schema.String]),
  Schema.Tuple([Schema.Literal('discord'), Schema.String, Schema.String, Schema.String]),
])
const decodeDiscordLocationSegments = Schema.decodeUnknownResult(DiscordLocationSegments)

interface DiscordGatewayMessage {
  readonly id?: string
  /** Numeric Discord message type; mirrors MessageType in discord-api-types. */
  readonly type?: number
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

// Thread system rows that must never reach Chat handling. Values mirror
// MessageType in discord-api-types. ThreadCreated is the "started a thread"
// row. ThreadStarterMessage is the native thread placeholder whose parent
// starter was already handled. Kept as named constants so the filter reads
// without bare numbers. Normal messages are 0 and replies are 19.
const DISCORD_THREAD_CREATED_MESSAGE_TYPE = 18
const DISCORD_THREAD_STARTER_MESSAGE_TYPE = 21

const isDiscordSystemMessageType = (type: number | undefined): boolean =>
  type === DISCORD_THREAD_CREATED_MESSAGE_TYPE || type === DISCORD_THREAD_STARTER_MESSAGE_TYPE

/** discord.js gateway client, typed through the adapter's own declarations. */
type DiscordGatewayClient = Parameters<DiscordAdapter['setupLegacyGatewayHandlers']>[0]
type DiscordGatewayShutdown = Parameters<DiscordAdapter['setupLegacyGatewayHandlers']>[1]
/** Forwarded MESSAGE_CREATE payload plus the optional raw type the wire retains. */
type DiscordForwardedMessage = Parameters<DiscordAdapter['handleForwardedMessage']>[0] & {
  readonly type?: number
}
type DiscordForwardedMessageOptions = Parameters<DiscordAdapter['handleForwardedMessage']>[1]

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

  private gatewayClient: DiscordGatewayClient | undefined
  private readonly reconnectListeners = new Set<() => void>()

  /**
   * Single-attempt global presence write. The activity lifecycle owns the
   * retry policy (exponential backoff, 5 total attempts, safe exhaustion log,
   * newer-wins versioning), so this never retries itself: it throws as a typed
   * `set-agent-activity` failure for the shared pipeline to schedule, and it
   * no-ops before connect with the reconnect resync converging afterwards.
   * Only aggregate counts cross this boundary.
   */
  readonly setPresence = (
    presence: DiscordPresence,
  ): Effect.Effect<void, ChatSdkPublicationError> =>
    Effect.try({
      try: () => {
        this.applyPresence(presence)
      },
      catch: (cause) => new ChatSdkPublicationError({ operation: 'set-agent-activity', cause }),
    })

  /**
   * Registers a gateway (re)connect listener invoked on every `clientReady`.
   * DiscordLive wires this to the shared activity resync, so reconnect writes
   * funnel through the same versioned retry pipeline as task transitions
   * instead of duplicating retry logic. Returns an unsubscribe function.
   */
  readonly onReconnect = (listener: () => void): (() => void) => {
    this.reconnectListeners.add(listener)
    return () => {
      this.reconnectListeners.delete(listener)
    }
  }

  /** One gateway write. No-ops before connect; throws on failure for retry. */
  private applyPresence(presence: DiscordPresence): void {
    const user = this.gatewayClient?.user
    // No gateway user before connect. The update is a no-op success; the
    // reconnect resync converges the current desired state afterwards.
    if (user === null || user === undefined) return
    user.setPresence({
      status: presence.status,
      // Numeric ActivityType.Playing keeps discord.js transitive. The client
      // type still flows from the adapter's own declarations.
      activities: presence.activity === undefined ? [] : [{ name: presence.activity, type: 0 }],
    })
  }

  protected override setupLegacyGatewayHandlers(
    client: DiscordGatewayClient,
    isShuttingDown: DiscordGatewayShutdown,
  ): void {
    super.setupLegacyGatewayHandlers(client, isShuttingDown)
    this.gatewayClient = client
    client.on('clientReady', () => {
      // Outside Effect here. Listeners trigger the shared activity resync,
      // which owns backoff, attempt budget, safe logging, and newer-wins.
      // No presence payload or failure cause is logged at this boundary.
      for (const listener of this.reconnectListeners) listener()
    })
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
    // location, author, and type fields.
    message: DiscordGatewayMessage,
    isMentioned: boolean,
  ): Promise<void> {
    // Drop thread system rows before any Chat state, thread creation,
    // admission, history load, or reply. Type 21 placeholders follow a
    // parent starter that was already handled, so both stay out.
    if (isDiscordSystemMessageType(message.type)) {
      this.logger.debug('Ignored Discord system message', {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        messageType: message.type,
      })
      return Promise.resolve()
    }
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

  /**
   * Defense in depth for forwarded MESSAGE_CREATE events. The wire payload
   * retains the raw message type, so the same thread system rows are dropped
   * here before any thread creation or Chat dispatch. The shared admission
   * contract stays untouched. This stays in the Discord forwarded hook.
   */
  protected override handleForwardedMessage(
    // SAFETY: forwarded payloads arrive as the adapter's own gateway data;
    // the gate only reads identifiers and the raw type.
    data: DiscordForwardedMessage,
    options?: DiscordForwardedMessageOptions,
  ): Promise<void> {
    if (isDiscordSystemMessageType(data.type)) {
      this.logger.debug('Ignored Discord system message', {
        guildId: data.guild_id,
        channelId: data.channel_id,
        messageId: data.id,
        messageType: data.type,
      })
      return Promise.resolve()
    }
    // SAFETY: data and options are the adapter's own forwarded shapes; the
    // base class accepts exactly what it produced.
    return super.handleForwardedMessage(data as never, options as never)
  }
}
