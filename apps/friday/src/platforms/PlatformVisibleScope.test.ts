import { assert, it } from '@effect/vitest'
import { ConversationBinding, PlatformMessageId } from '@friday/contracts/conversation'
import type { DiscordThreadId } from '@chat-adapter/discord'
import { Message } from 'chat'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  PlatformTargetNotFoundError,
  type DiscordQueryTarget,
  type SlackQueryTarget,
} from './PlatformAdapter.ts'
import {
  discoverDiscord,
  listDiscordMembers,
  type DiscordDiscoveryAdapter,
} from './discord/DiscordDiscovery.ts'
import {
  postDiscordMessage,
  searchDiscordMessages,
  type DiscordMessageQueryAdapter,
} from './discord/DiscordMessageSearch.ts'
import {
  discoverSlack,
  listSlackMembers,
  type SlackDiscoveryAdapter,
} from './slack/SlackDiscovery.ts'
import { postSlackMessage, searchSlackMessages } from './slack/SlackMessageSearch.ts'

const discordBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'message-3',
  conversationId: 'discord:guild-1:channel-1:thread-1',
})

const slackBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'slack',
  connectionId: 'slack-personal',
  channelId: 'slack:T123:C456',
  sourceMessageId: '1234567890.111111',
  conversationId: 'slack:T123:C456',
  scopeId: 'T123',
})

const isTargetNotFound = Schema.is(PlatformTargetNotFoundError)
const decodeMessageId = Schema.decodeSync(PlatformMessageId)

const discordMessage = (id: string, text: string) =>
  new Message({
    id,
    threadId: 'discord:guild-9:channel-9:thread-1',
    text,
    formatted: { type: 'root', children: [] },
    raw: {},
    author: { userId: 'user-1', userName: 'user-1', fullName: 'user-1', isBot: false, isMe: false },
    metadata: { dateSent: new Date('2026-03-21T09:00:00.000Z'), edited: false },
    attachments: [],
  })

// A guild/channel that Friday inbound policy would disable (not configured,
// disabled scope) but the bot token can still see through Discord REST.
// No policy object is consulted anywhere below: visibility comes from the
// adapter reads alone.
const visibleDiscordAdapter = (): DiscordDiscoveryAdapter & DiscordMessageQueryAdapter => ({
  decodeThreadId: (id: string): DiscordThreadId => {
    const [, guildId, channelId, threadId] = id.split(':')
    if (guildId === undefined || channelId === undefined) throw new Error(`Bad id: ${id}`)
    return threadId === undefined ? { guildId, channelId } : { guildId, channelId, threadId }
  },
  encodeThreadId: ({ guildId, channelId, threadId }: DiscordThreadId) =>
    threadId === undefined
      ? `discord:${guildId}:${channelId}`
      : `discord:${guildId}:${channelId}:${threadId}`,
  fetchChannelInfo: (channelId: string) => {
    const parts = channelId.split(':')
    const rawId = parts[3] ?? parts[2] ?? ''
    if (rawId === 'thread-9') {
      return Promise.resolve({
        id: channelId,
        metadata: { raw: { id: rawId, parent_id: 'channel-9', type: 11 } },
      })
    }
    return Promise.resolve({
      id: channelId,
      metadata: { raw: { id: rawId, type: 0, permission_overwrites: [] } },
    })
  },
  listThreads: () => Promise.resolve({ threads: [] }),
  fetchThreadMembers: () =>
    Promise.resolve([
      {
        user_id: 'U1',
        member: {
          user: { id: 'U1', username: 'alice', global_name: 'Alice', bot: false },
          nick: null,
        },
      },
    ]),
  fetchGuild: (guildId: string) => Promise.resolve({ id: guildId, owner_id: 'owner-0' }),
  fetchGuildRoles: () => Promise.resolve([{ id: 'guild-9', permissions: '1024' }]),
  fetchGuildMembers: () =>
    Promise.resolve([
      {
        user: { id: 'U1', username: 'alice', global_name: 'Alice', bot: false },
        nick: null,
        roles: [],
      },
    ]),
  fetchBotGuilds: () => Promise.resolve([{ id: 'guild-9', name: 'Previously Disabled' }]),
  fetchGuildChannels: (guildId: string) =>
    guildId === 'guild-9'
      ? Promise.resolve([{ id: 'channel-9', name: 'previously-closed', type: 0 }])
      : Promise.resolve([]),
  fetchMessages: () =>
    Promise.resolve({ messages: [discordMessage('message-1', 'hello visible')] }),
  fetchDirectMessage: (_channelId: string, messageId: string) =>
    Promise.resolve(discordMessage(messageId, 'hello visible')),
  postMessage: () => Promise.resolve({ id: 'posted-1', threadId: 'x', raw: {} }),
  postChannelMessage: () => Promise.resolve({ id: 'posted-1', threadId: 'x', raw: {} }),
})

const previouslyClosedDiscord: DiscordQueryTarget = {
  platform: 'discord',
  guildId: 'guild-9',
  channelId: 'channel-9',
}

it.effect('discovers a previously unadmitted but bot-visible guild and channel', () =>
  Effect.gen(function* () {
    const adapter = visibleDiscordAdapter()
    const scopes = yield* discoverDiscord(adapter, {
      binding: discordBinding,
      action: 'scopes',
      limit: 20,
    })
    assert.strictEqual(scopes.action, 'scopes')
    if (scopes.action !== 'scopes') return
    assert.deepStrictEqual(
      scopes.scopes.map((scope) => scope.id),
      ['guild-9'],
    )

    const channels = yield* discoverDiscord(adapter, {
      binding: discordBinding,
      action: 'channels',
      limit: 20,
    })
    assert.strictEqual(channels.action, 'channels')
    if (channels.action !== 'channels') return
    assert.deepStrictEqual(
      channels.channels.map((channel) =>
        channel.target.platform === 'discord' ? channel.target.channelId : 'unexpected',
      ),
      ['channel-9'],
    )
  }),
)

it.effect('queries and posts to a previously unadmitted but bot-visible channel', () =>
  Effect.gen(function* () {
    const adapter = visibleDiscordAdapter()
    const searched = yield* searchDiscordMessages(adapter, {
      binding: discordBinding,
      target: previouslyClosedDiscord,
      query: 'hello',
      limit: 20,
    })
    assert.strictEqual(searched.messages.length, 1)
    assert.strictEqual(searched.messages[0]?.text, 'hello visible')

    const posted = yield* postDiscordMessage(adapter, {
      binding: discordBinding,
      target: previouslyClosedDiscord,
      text: 'hello visible channel',
    })
    assert.strictEqual(posted.messageId, 'posted-1')
  }),
)

it.effect('inspects members of a previously unadmitted but bot-visible channel', () =>
  Effect.gen(function* () {
    const adapter = visibleDiscordAdapter()
    const result = yield* listDiscordMembers(adapter, {
      binding: discordBinding,
      target: previouslyClosedDiscord,
      limit: 20,
    })
    assert.deepStrictEqual(
      result.members.map((member) => member.platformUserId),
      ['U1'],
    )
  }),
)

it.effect('keeps Discord DMs out of tool targets', () =>
  Effect.gen(function* () {
    const adapter = visibleDiscordAdapter()
    const error = yield* searchDiscordMessages(adapter, {
      binding: discordBinding,
      target: { platform: 'discord', guildId: '@me', channelId: 'dm-1' },
      limit: 20,
    }).pipe(Effect.flip)
    assert(isTargetNotFound(error))
  }),
)

const slackMessage = (id: string, text: string) =>
  new Message({
    id,
    threadId: `slack:C999:${id}`,
    text,
    formatted: { type: 'root', children: [] },
    raw: { text, user: 'U123' },
    author: { userId: 'U123', userName: 'U123', fullName: 'U123', isBot: false, isMe: false },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
  })

const visibleSlackAdapter = (): SlackDiscoveryAdapter & {
  readonly fetchChannelMessages: (
    channelId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<{ readonly messages: Array<Message> }>
  readonly fetchMessages: (
    threadId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ) => Promise<{ readonly messages: Array<Message> }>
  readonly fetchMessage: (threadId: string, messageId: string) => Promise<Message | null>
  readonly postMessage: (
    threadId: string,
    text: string,
  ) => Promise<{ readonly id: string; readonly threadId: string; readonly raw: unknown }>
  readonly postChannelMessage: (
    channelId: string,
    text: string,
  ) => Promise<{ readonly id: string; readonly threadId: string; readonly raw: unknown }>
} => ({
  fetchChannelInfo: (channelId: string) =>
    Promise.resolve({ id: channelId, name: channelId.split(':')[1] ?? channelId, metadata: {} }),
  listThreads: () => Promise.resolve({ threads: [] }),
  webClient: {
    conversations: {
      members: () => Promise.resolve({ members: ['U1'], response_metadata: {} }),
      list: () =>
        Promise.resolve({
          channels: [{ id: 'C999', name: 'previously-closed' }],
          response_metadata: {},
        }),
    },
    users: {
      info: () => Promise.resolve({ user: { id: 'U1', name: 'alice' } }),
    },
  },
  fetchChannelMessages: () =>
    Promise.resolve({ messages: [slackMessage('100.1', 'hello visible')] }),
  fetchMessages: () => Promise.resolve({ messages: [slackMessage('100.1', 'hello visible')] }),
  fetchMessage: (_threadId: string, messageId: string) =>
    Promise.resolve(slackMessage(messageId, 'hello visible')),
  postMessage: (threadId: string) => Promise.resolve({ id: '300.3', threadId, raw: {} }),
  postChannelMessage: (channelId: string) =>
    Promise.resolve({ id: '300.3', threadId: channelId, raw: {} }),
})

const slackPolicy = { workspaceId: 'T123' }
const previouslyClosedSlack: SlackQueryTarget = {
  platform: 'slack',
  workspaceId: 'T123',
  channelId: 'C999',
}

it.effect('discovers a previously unadmitted but bot-visible Slack channel', () =>
  Effect.gen(function* () {
    const adapter = visibleSlackAdapter()
    const channels = yield* discoverSlack(
      adapter,
      { binding: slackBinding, action: 'channels', limit: 20 },
      slackPolicy,
    )
    assert.strictEqual(channels.action, 'channels')
    if (channels.action !== 'channels') return
    assert.deepStrictEqual(
      channels.channels.map((channel) =>
        channel.target.platform === 'slack' ? channel.target.channelId : 'unexpected',
      ),
      ['C999', 'C456'],
    )
  }),
)

it.effect(
  'queries, members, and posts to a previously unadmitted but bot-visible Slack channel',
  () =>
    Effect.gen(function* () {
      const adapter = visibleSlackAdapter()
      const searched = yield* searchSlackMessages(
        adapter,
        {
          binding: slackBinding,
          target: previouslyClosedSlack,
          query: 'hello',
          limit: 10,
        },
        slackPolicy,
      )
      assert.strictEqual(searched.messages.length, 1)

      const members = yield* listSlackMembers(
        adapter,
        {
          binding: slackBinding,
          target: previouslyClosedSlack,
          limit: 20,
        },
        slackPolicy,
      )
      assert.strictEqual(members.members.length, 1)

      const posted = yield* postSlackMessage(
        adapter,
        {
          binding: slackBinding,
          target: previouslyClosedSlack,
          text: 'hello visible',
        },
        slackPolicy,
      )
      assert.strictEqual(posted.messageId, '300.3')
    }),
)

it.effect('keeps Slack workspace boundaries for tool targets', () =>
  Effect.gen(function* () {
    const adapter = visibleSlackAdapter()
    const error = yield* searchSlackMessages(
      adapter,
      {
        binding: slackBinding,
        target: { platform: 'slack', workspaceId: 'T999', channelId: 'C999' },
        limit: 10,
      },
      slackPolicy,
    ).pipe(Effect.flip)
    assert(isTargetNotFound(error))
    assert.strictEqual(decodeMessageId('100.1'), '100.1')
  }),
)
