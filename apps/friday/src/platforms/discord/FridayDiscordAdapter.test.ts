/* oxlint-disable anti-slop/no-unknown-parameters -- The overrides mirror the adapter's declared protected HTTP-boundary signatures; recording the raw calls is the point of the test double. */

import type {
  DiscordAdapter,
  DiscordInteractionFlagsContext,
} from '@chat-adapter/discord'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'
import { FridayDiscordAdapter, type FridayDiscordAdapterConfig } from './FridayDiscordAdapter.ts'

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const THREAD = '333333333333333333'
const OTHER_GUILD = '444444444444444444'
const THREAD_ID_RESPONSE = '555555555555555555'

interface RecordedRequest {
  readonly path: string
  readonly method: string
}

interface RecordedDispatch {
  readonly threadId: string
}

const allowAll: DiscordResolvedChannelPolicy = {
  invocationMode: 'mention-only',
  replyMode: 'reply-in-thread',
  users: { mode: 'all', ids: [] },
}

/**
 * Recording adapter that stubs both Discord HTTP boundaries and the chat
 * dispatch point, so tests observe exactly what the adapter does at the
 * gateway boundary: which Discord API calls it makes, whether it creates a
 * thread, and whether a message or command reaches the chat handlers.
 */
class RecordingFridayDiscordAdapter extends FridayDiscordAdapter {
  readonly discordRequests: Array<RecordedRequest> = []
  readonly dispatchedMessages: Array<RecordedDispatch> = []
  readonly dispatchedCommands: Array<string> = []
  readonly policyLookups: Array<{ readonly guildId: string; readonly channelId: string }> = []

  constructor(
    config: Pick<FridayDiscordAdapterConfig, 'resolveChannelPolicy' | 'replyInChannelChannelIds'> &
      Partial<Pick<FridayDiscordAdapterConfig, 'interactionFlags'>>,
  ) {
    super({
      botToken: 'bot-token',
      applicationId: 'application-1',
      publicKey: 'public-key',
      ...config,
    } as FridayDiscordAdapterConfig)
  }

  /** Installs recording stand-ins for the chat dispatch points. */
  attachRecordingChat(): void {
    // SAFETY: the adapter only calls handleIncomingMessage/processSlashCommand
    // on its chat instance; the recordings capture exactly those calls.
    this.chat = {
      handleIncomingMessage: async (_adapter: unknown, threadId: string) => {
        this.dispatchedMessages.push({ threadId })
      },
      processSlashCommand: async (event: { readonly command: string }) => {
        this.dispatchedCommands.push(event.command)
      },
    } as never
  }

  protected override discordFetch(path: string, method: string): Promise<Response> {
    this.discordRequests.push({ path, method })
    return Promise.resolve(
      new Response(JSON.stringify({ id: THREAD_ID_RESPONSE, name: 'Thread' }), { status: 200 }),
    )
  }

  protected override discordInteractionFetch(path: string, method: string): Promise<Response> {
    this.discordRequests.push({ path, method })
    return Promise.resolve(new Response(JSON.stringify({ id: 'message-1' }), { status: 200 }))
  }

  /** Exposes the protected gateway message entry point for the test. */
  runGatewayMessage(message: unknown, isMentioned: boolean): Promise<void> {
    // SAFETY: the gateway dispatches discord.js messages; the recording stub
    // carries every field the adapter's gateway path touches.
    return super.handleGatewayMessage(message as never, isMentioned)
  }

  /** Exposes the protected application-command entry point for the test. */
  runApplicationCommandInteraction(
    context: DiscordInteractionFlagsContext,
    flags?: number,
  ): void {
    super.handleApplicationCommandInteraction(context, flags)
  }
}

const guildMessage = (overrides: {
  readonly guildId?: string | null
  readonly channelId?: string
  readonly isThread?: boolean
  readonly parentId?: string | null
  readonly authorId?: string
  readonly id?: string
}) => ({
  id: overrides.id ?? 'message-1',
  guildId: overrides.guildId === undefined ? GUILD : overrides.guildId,
  channelId: overrides.channelId ?? CHANNEL,
  content: 'hello Friday',
  attachments: new Map(),
  author: {
    id: overrides.authorId ?? 'author-1',
    username: 'alice',
    bot: false,
    displayName: 'alice',
  },
  createdAt: new Date('2026-01-01T00:00:00Z'),
  editedAt: null,
  channel: {
    isThread: () => overrides.isThread ?? false,
    parentId: overrides.parentId ?? null,
  },
})

const applicationCommand = (channelId: string, command = '/friday') => ({
  channelId,
  command,
  // SAFETY: only the interaction token is read on the reply path; the gate
  // itself reads nothing from the interaction.
  interaction: { token: 'interaction-token' } as never,
  text: '',
  user: {
    id: 'author-1',
    username: 'alice',
    discriminator: '0001',
    global_name: 'alice',
    bot: false,
  },
})

it.effect('drops messages from unregistered and disabled guilds before any thread creation', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter({
      // Only one guild is configured; everything else resolves to nothing.
      resolveChannelPolicy: (guildId) => (guildId === GUILD ? allowAll : undefined),
      replyInChannelChannelIds: () => [],
    })
    discord.attachRecordingChat()

    await discord.runGatewayMessage(guildMessage({ guildId: OTHER_GUILD }), true)
    await discord.runGatewayMessage(guildMessage({ guildId: OTHER_GUILD }), false)

    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.dispatchedMessages, [])
  }),
)

it.effect('drops denied users before dispatching or creating anything', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: () => ({
        ...allowAll,
        users: { mode: 'deny', ids: ['author-1'] },
      }),
      replyInChannelChannelIds: () => [],
    })
    discord.attachRecordingChat()

    await discord.runGatewayMessage(guildMessage({}), true)

    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.dispatchedMessages, [])
  }),
)

it.effect('creates a thread for a mention in an enabled guild', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: (guildId, channelId) => {
        discord.policyLookups.push({ guildId, channelId })
        return allowAll
      },
      replyInChannelChannelIds: () => [],
    })
    discord.attachRecordingChat()

    await discord.runGatewayMessage(guildMessage({}), true)

    assert.deepStrictEqual(discord.discordRequests, [
      { path: `/channels/${CHANNEL}/messages/message-1/threads`, method: 'POST' },
    ])
    // The dispatched conversation binding carries the created thread.
    assert.deepStrictEqual(discord.dispatchedMessages, [
      {
        threadId: `discord:${GUILD}:${CHANNEL}:${THREAD_ID_RESPONSE}`,
      },
    ])
  }),
)

it.effect('resolves thread messages from the parent channel and keeps them in the thread', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: (guildId, channelId) => {
        discord.policyLookups.push({ guildId, channelId })
        return allowAll
      },
      replyInChannelChannelIds: () => [],
    })
    discord.attachRecordingChat()

    await discord.runGatewayMessage(
      guildMessage({ channelId: THREAD, isThread: true, parentId: CHANNEL }),
      true,
    )

    // Policy resolved from the parent channel, not the thread id…
    assert.deepStrictEqual(discord.policyLookups, [{ guildId: GUILD, channelId: CHANNEL }])
    // …no new thread was created for a message that already lives in one…
    assert.deepStrictEqual(discord.discordRequests, [])
    // …and the dispatch stays bound to the existing thread.
    assert.deepStrictEqual(discord.dispatchedMessages, [
      { threadId: `discord:${GUILD}:${CHANNEL}:${THREAD}` },
    ])
  }),
)

it.effect('keeps reply-in-channel parents at channel scope instead of creating a thread', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: () => allowAll,
      replyInChannelChannelIds: () => [CHANNEL],
    })
    discord.attachRecordingChat()

    await discord.runGatewayMessage(guildMessage({}), true)

    // The reply-in-channel override intercepts thread creation: no Discord API
    // call is made and the conversation binds to the channel itself.
    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.dispatchedMessages, [
      { threadId: `discord:${GUILD}:${CHANNEL}:${CHANNEL}` },
    ])
  }),
)

it.effect(
  'keeps a manually created thread in that thread even when its parent is reply-in-channel',
  () =>
    Effect.promise(async () => {
      const discord = new RecordingFridayDiscordAdapter({
        resolveChannelPolicy: (guildId, channelId) => {
          discord.policyLookups.push({ guildId, channelId })
          return allowAll
        },
        replyInChannelChannelIds: () => [CHANNEL],
      })
      discord.attachRecordingChat()

      await discord.runGatewayMessage(
        guildMessage({ channelId: THREAD, isThread: true, parentId: CHANNEL }),
        true,
      )

      // Policy still resolves from the parent, but the reply-in-channel
      // override must not hijack an existing thread into the parent channel.
      assert.deepStrictEqual(discord.policyLookups, [{ guildId: GUILD, channelId: CHANNEL }])
      assert.deepStrictEqual(discord.discordRequests, [])
      assert.deepStrictEqual(discord.dispatchedMessages, [
        { threadId: `discord:${GUILD}:${CHANNEL}:${THREAD}` },
      ])
    }),
)

it.effect('reads the policy snapshot again on every message so reloads apply live', () =>
  Effect.promise(async () => {
    let enabled = false
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: () => (enabled ? allowAll : undefined),
      replyInChannelChannelIds: () => [],
    })
    discord.attachRecordingChat()

    await discord.runGatewayMessage(guildMessage({}), true)
    assert.deepStrictEqual(discord.dispatchedMessages, [])

    // A configuration reload flips the guild on between the two messages; the
    // adapter re-resolves the policy per message without being rebuilt.
    enabled = true
    await discord.runGatewayMessage(guildMessage({}), true)
    assert.deepStrictEqual(discord.discordRequests, [
      { path: `/channels/${CHANNEL}/messages/message-1/threads`, method: 'POST' },
    ])
    assert.deepStrictEqual(discord.dispatchedMessages.length, 1)
  }),
)

it.effect('reads the reply-in-channel list again on every thread creation', () =>
  Effect.promise(async () => {
    let replyInChannel = false
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: () => allowAll,
      replyInChannelChannelIds: () => (replyInChannel ? [CHANNEL] : []),
    })
    discord.attachRecordingChat()

    await discord.runGatewayMessage(guildMessage({}), true)
    assert.deepStrictEqual(discord.discordRequests, [
      { path: `/channels/${CHANNEL}/messages/message-1/threads`, method: 'POST' },
    ])

    replyInChannel = true
    await discord.runGatewayMessage(guildMessage({ id: 'message-2' }), true)
    assert.deepStrictEqual(discord.discordRequests.length, 1)
    assert.deepStrictEqual(discord.dispatchedMessages, [
      { threadId: `discord:${GUILD}:${CHANNEL}:${THREAD_ID_RESPONSE}` },
      { threadId: `discord:${GUILD}:${CHANNEL}:${CHANNEL}` },
    ])
  }),
)

it.effect('drops application commands from unregistered and disabled guilds', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: (guildId) => (guildId === GUILD ? allowAll : undefined),
      replyInChannelChannelIds: () => [],
    })
    discord.attachRecordingChat()

    // Unregistered guild…
    discord.runApplicationCommandInteraction(
      applicationCommand(`discord:${OTHER_GUILD}:${CHANNEL}`) as never,
    )
    // …disabled guild…
    discord.runApplicationCommandInteraction(
      applicationCommand(`discord:${OTHER_GUILD}:${CHANNEL}`, '/friday reload') as never,
    )
    // …and an unresolvable location all reach neither Discord nor the handlers.
    discord.runApplicationCommandInteraction(applicationCommand('not-a-discord-id') as never)

    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.dispatchedCommands, [])
  }),
)

it.effect('keeps direct-message application commands operational', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: (guildId, channelId) => {
        discord.policyLookups.push({ guildId, channelId })
        return allowAll
      },
      replyInChannelChannelIds: () => [],
    })
    discord.attachRecordingChat()

    discord.runApplicationCommandInteraction(
      applicationCommand(`discord:@me:${CHANNEL}`, '/friday reload') as never,
    )

    // DMs have no guild: the command dispatches to the handlers even though no
    // guild policy exists.
    assert.deepStrictEqual(discord.dispatchedCommands, ['/friday reload'])
    assert.deepStrictEqual(discord.discordRequests, [])
    assert.deepStrictEqual(discord.policyLookups, [])
  }),
)

it.effect('dispatches application commands inside enabled guilds', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter({
      resolveChannelPolicy: (guildId, channelId) => {
        discord.policyLookups.push({ guildId, channelId })
        return allowAll
      },
      replyInChannelChannelIds: () => [],
    })
    discord.attachRecordingChat()

    discord.runApplicationCommandInteraction(
      applicationCommand(`discord:${GUILD}:${CHANNEL}`, '/friday reload') as never,
    )
    // A thread-scoped interaction resolves its gate from the parent channel.
    discord.runApplicationCommandInteraction(
      applicationCommand(`discord:${GUILD}:${CHANNEL}:${THREAD}`) as never,
    )

    assert.deepStrictEqual(discord.dispatchedCommands, ['/friday reload', '/friday'])
    assert.deepStrictEqual(discord.policyLookups, [
      { guildId: GUILD, channelId: CHANNEL },
      { guildId: GUILD, channelId: CHANNEL },
    ])
  }),
)
