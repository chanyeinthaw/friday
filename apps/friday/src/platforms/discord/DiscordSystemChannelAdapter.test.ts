import { assert, it } from '@effect/vitest'

import { FridayDiscordAdapter } from './DiscordSystemChannelAdapter.ts'

/** Records adapter side effects without touching the Discord API. */
class RecordingFridayAdapter extends FridayDiscordAdapter {
  readonly threadCreations: Array<[channelId: string, messageId: string]> = []
  readonly forwardedMessages: Array<{ threadId: string; isMention: boolean }> = []

  constructor(options: {
    readonly isAllowedLocation: (guildId: string, channelId: string) => boolean
  }) {
    super({
      botToken: 'test-token',
      applicationId: 'application-1',
      publicKey: 'public-key',
      isAllowedLocation: options.isAllowedLocation,
    })
    // SAFETY: The gateway handler only needs handleIncomingMessage to be observable.
    this.chat = {
      handleIncomingMessage: (
        _adapter: FridayDiscordAdapter,
        threadId: string,
        message: { isMention: boolean },
      ) => {
        this.forwardedMessages.push({ threadId, isMention: message.isMention })
        return Promise.resolve()
      },
    } as never
  }

  protected override createDiscordThread(channelId: string, messageId: string) {
    this.threadCreations.push([channelId, messageId])
    return Promise.resolve({ id: `thread-for-${messageId}`, name: 'recorded' })
  }

  gateway(message: GatewayMessage, isMentioned = true): Promise<void> {
    return this.handleGatewayMessage(message, isMentioned)
  }
}

interface GatewayMessage {
  readonly id: string
  readonly guildId: string | null
  readonly channelId: string
  readonly channel: {
    readonly isThread: () => boolean
    readonly parentId?: string | null
  }
}

const gatewayMessage = (location: {
  readonly guildId: string | null
  readonly channelId: string
  readonly parentChannelId?: string
}) => ({
  id: 'message-1',
  guildId: location.guildId,
  channelId: location.channelId,
  content: '<@application-1> hello',
  author: { id: 'user-1', username: 'chan', bot: false },
  createdAt: new Date(0),
  editedAt: null,
  attachments: new Map(),
  channel: {
    isThread: () => location.parentChannelId !== undefined,
    parentId: location.parentChannelId ?? null,
  },
})

const allowGuild1 = (guildId: string): boolean => guildId === 'guild-1'

it('creates a thread and forwards mentions from configured guilds', async () => {
  const adapter = new RecordingFridayAdapter({ isAllowedLocation: allowGuild1 })
  await adapter.gateway(gatewayMessage({ guildId: 'guild-1', channelId: 'channel-1' }))
  assert.deepEqual(adapter.threadCreations, [['channel-1', 'message-1']])
  assert.equal(adapter.forwardedMessages.length, 1)
  assert.equal(adapter.forwardedMessages[0]?.isMention, true)
})

it('ignores mentions from unconfigured guilds before creating a thread', async () => {
  const adapter = new RecordingFridayAdapter({ isAllowedLocation: allowGuild1 })
  await adapter.gateway(gatewayMessage({ guildId: 'guild-2', channelId: 'channel-1' }))
  assert.deepEqual(adapter.threadCreations, [])
  assert.deepEqual(adapter.forwardedMessages, [])
})

it('ignores mentions from unconfigured channels in configured guilds', async () => {
  const adapter = new RecordingFridayAdapter({
    isAllowedLocation: (guildId, channelId) => guildId === 'guild-1' && channelId === 'channel-1',
  })
  await adapter.gateway(gatewayMessage({ guildId: 'guild-1', channelId: 'channel-2' }))
  assert.deepEqual(adapter.threadCreations, [])
  assert.deepEqual(adapter.forwardedMessages, [])
})

it('allows messages in child threads of configured parent channels', async () => {
  const adapter = new RecordingFridayAdapter({
    isAllowedLocation: (guildId, channelId) => guildId === 'guild-1' && channelId === 'channel-1',
  })
  await adapter.gateway(
    gatewayMessage({ guildId: 'guild-1', channelId: 'thread-9', parentChannelId: 'channel-1' }),
    false,
  )
  assert.deepEqual(adapter.threadCreations, [])
  assert.equal(adapter.forwardedMessages.length, 1)
  assert.equal(adapter.forwardedMessages[0]?.isMention, false)
})

it('ignores messages in child threads of unconfigured parent channels', async () => {
  const adapter = new RecordingFridayAdapter({
    isAllowedLocation: (guildId, channelId) => guildId === 'guild-1' && channelId === 'channel-1',
  })
  await adapter.gateway(
    gatewayMessage({ guildId: 'guild-1', channelId: 'thread-9', parentChannelId: 'channel-2' }),
  )
  assert.deepEqual(adapter.threadCreations, [])
  assert.deepEqual(adapter.forwardedMessages, [])
})
