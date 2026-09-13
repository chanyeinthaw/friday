/* oxlint-disable anti-slop/no-unknown-parameters -- The overrides mirror the adapter's declared protected HTTP-boundary signatures; recording the calls is the point of the test double. */

import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { projectChatSdkMessage } from '../chat-sdk/MessageProjection.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'
import { FridayDiscordAdapter, type FridayDiscordAdapterConfig } from './FridayDiscordAdapter.ts'

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const THREAD = '333333333333333333'

const mentionOnly: DiscordResolvedChannelPolicy = {
  invocationMode: 'mention-only',
  replyMode: 'reply-in-thread',
  users: { mode: 'all', ids: [] },
}

const allMessages: DiscordResolvedChannelPolicy = {
  ...mentionOnly,
  invocationMode: 'all-messages',
}

class RecordingAdapter extends FridayDiscordAdapter {
  readonly discordRequests: Array<{ readonly path: string; readonly method: string }> = []
  readonly dispatchedMessages: Array<{ readonly threadId: string }> = []

  constructor(policy: DiscordResolvedChannelPolicy) {
    // SAFETY: required Discord credentials and Friday policy callbacks are all
    // present; the test only omits unrelated optional adapter configuration.
    super({
      botToken: 'bot-token',
      applicationId: 'application-1',
      publicKey: 'public-key',
      resolveChannelPolicy: () => policy,
      replyInChannelChannelIds: () => [],
    } as FridayDiscordAdapterConfig)
  }

  attachRecordingChat(): void {
    // SAFETY: the adapter only calls handleIncomingMessage on its chat
    // instance; the recording captures exactly those calls.
    this.chat = {
      handleIncomingMessage: async (_adapter: unknown, threadId: string) => {
        this.dispatchedMessages.push({ threadId })
      },
    } as never
  }

  protected override discordFetch(path: string, method: string): Promise<Response> {
    this.discordRequests.push({ path, method })
    return Promise.resolve(
      new Response(JSON.stringify({ id: '999999999999999999', name: 'Thread' }), { status: 200 }),
    )
  }

  runGatewayMessage(message: unknown, isMentioned: boolean): Promise<void> {
    // SAFETY: the gateway dispatches discord.js messages; the stub carries
    // every field the adapter path touches.
    return super.handleGatewayMessage(message as never, isMentioned)
  }

  runForwardedMessage(data: unknown): Promise<void> {
    // SAFETY: forwarded payloads arrive as the adapter's own gateway data;
    // the stub carries every field the forwarded path touches.
    return super.handleForwardedMessage(data as never)
  }
}

const gatewayMessage = (overrides: {
  readonly id?: string
  readonly type?: number
  readonly channelId?: string
  readonly isThread?: boolean
  readonly parentId?: string | null
  readonly content?: string
  readonly attachments?: Map<string, unknown>
}) => ({
  id: overrides.id ?? 'message-1',
  type: overrides.type,
  guildId: GUILD,
  channelId: overrides.channelId ?? CHANNEL,
  content: overrides.content ?? 'hello Friday',
  attachments: overrides.attachments ?? new Map(),
  author: { id: 'author-1', username: 'alice', bot: false, displayName: 'alice' },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  editedAt: null,
  channel: {
    isThread: () => overrides.isThread ?? false,
    parentId: overrides.parentId ?? null,
  },
})

const forwardedMessage = (overrides: { readonly type?: number; readonly content?: string }) => ({
  id: 'message-1',
  type: overrides.type,
  guild_id: GUILD,
  channel_id: CHANNEL,
  content: overrides.content ?? 'hello Friday',
  timestamp: '2026-01-01T00:00:00.000Z',
  author: { id: 'author-1', username: 'alice', global_name: 'alice', bot: false },
  mentions: [],
  attachments: [],
})

it.effect('drops thread system rows on the live path in mention-only mode', () =>
  Effect.promise(async () => {
    const discord = new RecordingAdapter(mentionOnly)
    discord.attachRecordingChat()

    await discord.runGatewayMessage(gatewayMessage({ type: 18 }), true)
    await discord.runGatewayMessage(gatewayMessage({ type: 21, id: 'message-2' }), true)

    // No thread creation and no Chat dispatch, so nothing downstream can
    // persist, acknowledge, or publish.
    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.dispatchedMessages, [])
  }),
)

it.effect('drops thread system rows on the live path in all-messages mode', () =>
  Effect.promise(async () => {
    const discord = new RecordingAdapter(allMessages)
    discord.attachRecordingChat()

    await discord.runGatewayMessage(gatewayMessage({ type: 18 }), false)
    await discord.runGatewayMessage(gatewayMessage({ type: 21, id: 'message-2' }), false)

    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.dispatchedMessages, [])
  }),
)

it.effect('keeps normal messages and replies dispatching', () =>
  Effect.promise(async () => {
    const discord = new RecordingAdapter(mentionOnly)
    discord.attachRecordingChat()

    await discord.runGatewayMessage(gatewayMessage({ type: 0 }), true)
    await discord.runGatewayMessage(gatewayMessage({ type: 19, id: 'message-2' }), true)

    assert.strictEqual(discord.dispatchedMessages.length, 2)
    assert.strictEqual(discord.discordRequests.length, 2)
  }),
)

it.effect('keeps attachment-only normal messages dispatching', () =>
  Effect.promise(async () => {
    const discord = new RecordingAdapter(mentionOnly)
    discord.attachRecordingChat()

    await discord.runGatewayMessage(
      gatewayMessage({
        type: 0,
        content: '',
        attachments: new Map([['a-1', { url: 'https://cdn/image.png' }]]),
      }),
      true,
    )

    // Empty text alone never drops; only the thread system types do.
    assert.strictEqual(discord.dispatchedMessages.length, 1)
  }),
)

it.effect('keeps genuine follow-ups inside native threads dispatching', () =>
  Effect.promise(async () => {
    const discord = new RecordingAdapter(mentionOnly)
    discord.attachRecordingChat()

    await discord.runGatewayMessage(
      gatewayMessage({ type: 0, channelId: THREAD, isThread: true, parentId: CHANNEL }),
      true,
    )

    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.dispatchedMessages, [
      { threadId: `discord:${GUILD}:${CHANNEL}:${THREAD}` },
    ])
  }),
)

it.effect('drops forwarded thread system rows before any thread creation', () =>
  Effect.promise(async () => {
    const discord = new RecordingAdapter(mentionOnly)
    discord.attachRecordingChat()

    await discord.runForwardedMessage(forwardedMessage({ type: 18 }))
    await discord.runForwardedMessage(forwardedMessage({ type: 21 }))

    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.dispatchedMessages, [])
  }),
)

it.effect('keeps forwarded normal messages dispatching', () =>
  Effect.promise(async () => {
    const discord = new RecordingAdapter(mentionOnly)
    discord.attachRecordingChat()

    await discord.runForwardedMessage({ ...forwardedMessage({ type: 0 }), is_mention: true })

    assert.strictEqual(discord.dispatchedMessages.length, 1)
  }),
)

it.effect('keeps replyTo projection for type 19', () =>
  Effect.sync(() => {
    const inbound = projectChatSdkMessage(
      'discord',
      {
        adapter: { name: 'discord' },
        channelId: 'discord-channel-1',
        id: 'discord-thread-1',
      },
      {
        id: 'discord-message-1',
        text: 'What did you mean?',
        raw: {
          type: 19,
          referenced_message: {
            id: 'discord-message-0',
            content: 'The original question',
            author: { id: 'user-0', username: 'bob', global_name: 'Bob' },
          },
        },
        author: {
          userId: 'user-1',
          userName: 'user',
          fullName: 'User',
          isBot: false,
          isMe: false,
        },
      },
    )

    assert(inbound.message.replyTo !== undefined)
    assert.strictEqual(String(inbound.message.replyTo.platformMessageId), 'discord-message-0')
  }),
)
