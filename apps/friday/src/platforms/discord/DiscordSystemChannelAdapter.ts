import { DiscordAdapter, type DiscordAdapterConfig } from '@chat-adapter/discord'

/**
 * Keeps configured system channels at channel scope. The upstream adapter creates a Discord child
 * thread before Friday receives a mention, so system channels return their own channel ID instead.
 */
export class FridayDiscordAdapter extends DiscordAdapter {
  readonly systemChannelIds: ReadonlySet<string>

  constructor(
    config: DiscordAdapterConfig & { readonly systemChannelIds?: ReadonlyArray<string> },
  ) {
    super(config)
    this.systemChannelIds = new Set(config.systemChannelIds ?? [])
  }

  protected override createDiscordThread(
    channelId: string,
    messageId: string,
  ): Promise<{ id: string; name: string }> {
    return this.systemChannelIds.has(channelId)
      ? Promise.resolve({ id: channelId, name: channelId })
      : super.createDiscordThread(channelId, messageId)
  }
}
