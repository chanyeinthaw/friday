import { DiscordAdapter, type DiscordAdapterConfig } from '@chat-adapter/discord'

/** Location fields of a discord.js gateway message needed for the allowlist gate. */
interface DiscordGatewayMessageLocation {
  readonly guildId: string | null
  readonly channelId: string
  readonly channel: {
    readonly isThread: () => boolean
    readonly parentId?: string | null
  }
}

export type FridayDiscordAdapterConfig = DiscordAdapterConfig & {
  /**
   * Provider for the configured system channel IDs, read on every check so
   * configuration reloads apply without rebuilding the adapter.
   */
  readonly systemChannelIds?: () => ReadonlyArray<string>
  /**
   * Location allowlist consulted before the adapter takes any externally visible
   * action. The upstream adapter creates a Discord thread for every mention before
   * Chat SDK handlers run, so unconfigured guilds/channels must be dropped here.
   */
  readonly isAllowedLocation: (guildId: string, channelId: string) => boolean
}

/**
 * Keeps configured system channels at channel scope. The upstream adapter creates a Discord child
 * thread before Friday receives a mention, so system channels return their own channel ID instead.
 * It also drops messages from unconfigured guilds/channels before that thread creation happens.
 */
export class FridayDiscordAdapter extends DiscordAdapter {
  private readonly systemChannelIdsProvider: () => ReadonlyArray<string>
  private readonly isAllowedLocation: FridayDiscordAdapterConfig['isAllowedLocation']

  constructor(config: FridayDiscordAdapterConfig) {
    super(config)
    this.systemChannelIdsProvider = config.systemChannelIds ?? (() => [])
    this.isAllowedLocation = config.isAllowedLocation
  }

  /** Live view of the configured system channels for adapter-side thread routing. */
  protected get systemChannelIdList(): ReadonlyArray<string> {
    return this.systemChannelIdsProvider()
  }

  protected override createDiscordThread(
    channelId: string,
    messageId: string,
  ): Promise<{ id: string; name: string }> {
    return this.systemChannelIdList.includes(channelId)
      ? Promise.resolve({ id: channelId, name: channelId })
      : super.createDiscordThread(channelId, messageId)
  }

  protected override handleGatewayMessage(
    message: DiscordGatewayMessageLocation,
    isMentioned: boolean,
  ): Promise<void> {
    // Mirror the upstream parent-channel resolution so threads of allowed channels stay allowed.
    const parentId = message.channel.isThread() ? (message.channel.parentId ?? null) : null
    const parentChannelId = parentId ?? message.channelId
    if (!this.isAllowedLocation(message.guildId ?? '@me', parentChannelId)) {
      this.logger.debug('Ignored message from unconfigured guild or channel', {
        guildId: message.guildId,
        channelId: message.channelId,
      })
      return Promise.resolve()
    }
    // SAFETY: The gateway dispatches discord.js messages; the gate only reads location fields.
    return super.handleGatewayMessage(message as never, isMentioned)
  }
}
