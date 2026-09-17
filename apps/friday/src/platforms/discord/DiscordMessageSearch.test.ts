import { assert, it } from '@effect/vitest'
import { ConversationBinding, PlatformMessageId } from '@friday/contracts/conversation'
import { Message } from 'chat'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { DiscordThreadId } from '@chat-adapter/discord'
import { searchDiscordMessages, getDiscordMessage } from './DiscordMessageSearch.ts'
import { PlatformMessageNotFoundError, type PlatformMessageGetResult } from '../PlatformAdapter.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'

const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'message-3',
  conversationId: 'discord:guild-1:channel-1:thread-1',
})
const message = (id: string, text: string, userId = 'user-1', isBot = false) =>
  new Message({
    id,
    threadId: 'discord:guild-1:channel-1:thread-1',
    text,
    formatted: { type: 'root', children: [] },
    raw: {},
    author: { userId, userName: userId, fullName: userId, isBot, isMe: false },
    metadata: { dateSent: new Date('2026-03-21T09:00:00.000Z'), edited: false },
    attachments: [],
  })

it.effect('searches the current thread and returns attributed messages', () =>
  Effect.gen(function* () {
    const sources: Array<string> = []
    const result = yield* searchDiscordMessages(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
        }),
        encodeThreadId: ({ guildId, channelId, threadId }) =>
          `discord:${guildId}:${channelId}:${threadId}`,
        fetchMessages: (source) => {
          sources.push(source)
          return Promise.resolve({
            messages: [
              message('message-1', 'Dokploy deploy failed', 'user-1'),
              message('message-2', 'Unrelated note', 'user-2'),
            ],
          })
        },
      },
      { binding, scope: 'thread', query: 'dokploy', limit: 20 },
    )

    assert.deepStrictEqual(sources, ['discord:guild-1:channel-1:thread-1'])
    assert.strictEqual(result.messages.length, 1)
    assert.strictEqual(result.messages[0]?.text, 'Dokploy deploy failed')
    assert.strictEqual(result.scannedCount, 2)
    assert.strictEqual(result.truncated, false)
  }),
)

it.effect('fetches from the parent channel when channel scope is requested', () =>
  Effect.gen(function* () {
    const sources: Array<string> = []
    yield* searchDiscordMessages(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
        }),
        encodeThreadId: ({ guildId, channelId, threadId }) =>
          `discord:${guildId}:${channelId}:${threadId}`,
        fetchMessages: (source) => {
          sources.push(source)
          return Promise.resolve({ messages: [] })
        },
      },
      { binding, scope: 'channel', limit: 20 },
    )

    assert.deepStrictEqual(sources, ['discord:guild-1:channel-1:channel-1'])
  }),
)

const decodeMessageId = Schema.decodeSync(PlatformMessageId)

const admitted = (): DiscordResolvedChannelPolicy => ({
  invocationMode: 'mention-only',
  replyMode: 'reply-in-thread',
  users: { mode: 'all', ids: [] },
})

const getAdapter = (options: {
  readonly channelRaw?: unknown
  readonly fetch?: (channelId: string, messageId: string) => Promise<Message>
}) => ({
  decodeThreadId: (id: string): DiscordThreadId => {
    const [, guildId, channelId, threadId] = id.split(':')
    if (guildId === undefined || channelId === undefined) {
      throw new Error(`Malformed Discord conversation id: ${id}`)
    }
    return threadId === undefined ? { guildId, channelId } : { guildId, channelId, threadId }
  },
  encodeThreadId: ({ guildId, channelId, threadId }: DiscordThreadId) =>
    threadId === undefined || threadId === channelId
      ? `discord:${guildId}:${channelId}`
      : `discord:${guildId}:${channelId}:${threadId}`,
  fetchChannelInfo: (channelId: string) =>
    Promise.resolve({ id: channelId, metadata: { raw: options.channelRaw ?? {} } }),
  fetchDirectMessage: options.fetch ?? (() => Promise.reject(new Error('unexpected fetch'))),
})

const isMessageNotFound = Schema.is(PlatformMessageNotFoundError)

const notFound = (effect: Effect.Effect<PlatformMessageGetResult, PlatformMessageNotFoundError>) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(effect)
    assert(isMessageNotFound(error))
    assert.strictEqual(error.message, 'Message not found.')
  })

it.effect('retrieves a bare message id within the selected thread scope', () =>
  Effect.gen(function* () {
    const fetches: Array<[string, string]> = []
    const result = yield* getDiscordMessage(
      getAdapter({
        fetch: (channelId, messageId) => {
          fetches.push([channelId, messageId])
          return Promise.resolve(message('message-9', 'hello'))
        },
      }),
      { binding, scope: 'thread', messageId: decodeMessageId('message-9') },
      { resolveChannelPolicy: () => undefined },
    )

    assert.deepStrictEqual(fetches, [['thread-1', 'message-9']])
    assert.strictEqual(result.message.id, 'message-9')
    assert.strictEqual(result.message.text, 'hello')
    assert.strictEqual(result.message.sentAt, '2026-03-21T09:00:00.000Z')
    assert.strictEqual(result.message.replyToMessageId, null)
  }),
)

it.effect('retrieves a bare message id from the parent channel under channel scope', () =>
  Effect.gen(function* () {
    const fetches: Array<[string, string]> = []
    yield* getDiscordMessage(
      getAdapter({
        fetch: (channelId, messageId) => {
          fetches.push([channelId, messageId])
          return Promise.resolve(message('message-9', 'hello'))
        },
      }),
      { binding, scope: 'channel', messageId: decodeMessageId('message-9') },
      { resolveChannelPolicy: () => undefined },
    )

    assert.deepStrictEqual(fetches, [['channel-1', 'message-9']])
  }),
)

it.effect('fetches a message URL in an admitted channel and preserves bot authors', () =>
  Effect.gen(function* () {
    const policyLookups: Array<[string, string]> = []
    const result = yield* getDiscordMessage(
      getAdapter({ fetch: () => Promise.resolve(message('message-9', 'beep', 'bot-1', true)) }),
      {
        binding,
        scope: 'thread',
        messageUrl: 'https://discord.com/channels/guild-1/channel-1/message-9',
      },
      {
        resolveChannelPolicy: (guildId, channelId) => {
          policyLookups.push([guildId, channelId])
          return admitted()
        },
      },
    )

    assert.deepStrictEqual(policyLookups, [['guild-1', 'channel-1']])
    assert.strictEqual(result.message.id, 'message-9')
    assert.strictEqual(result.message.author.platformUserId, 'bot-1')
  }),
)

it.effect('inherits the parent channel policy for thread URLs', () =>
  Effect.gen(function* () {
    const policyLookups: Array<[string, string]> = []
    const fetches: Array<[string, string]> = []
    yield* getDiscordMessage(
      getAdapter({
        channelRaw: { id: 'thread-9', parent_id: 'channel-1', type: 11 },
        fetch: (channelId, messageId) => {
          fetches.push([channelId, messageId])
          return Promise.resolve(message('message-9', 'hello'))
        },
      }),
      {
        binding,
        scope: 'thread',
        messageUrl: 'https://discord.com/channels/guild-1/thread-9/message-9',
      },
      {
        resolveChannelPolicy: (guildId, channelId) => {
          policyLookups.push([guildId, channelId])
          return admitted()
        },
      },
    )

    assert.deepStrictEqual(policyLookups, [['guild-1', 'channel-1']])
    assert.deepStrictEqual(fetches, [['thread-9', 'message-9']])
  }),
)

it.effect('gates non-thread URL channels on the channel itself', () =>
  Effect.gen(function* () {
    const policyLookups: Array<[string, string]> = []
    yield* getDiscordMessage(
      getAdapter({
        channelRaw: { id: 'channel-1', type: 0 },
        fetch: () => Promise.resolve(message('message-9', 'hello')),
      }),
      {
        binding,
        scope: 'thread',
        messageUrl: 'https://discord.com/channels/guild-1/channel-1/message-9',
      },
      {
        resolveChannelPolicy: (guildId, channelId) => {
          policyLookups.push([guildId, channelId])
          return admitted()
        },
      },
    )

    assert.deepStrictEqual(policyLookups, [['guild-1', 'channel-1']])
  }),
)

it.effect('rejects message URLs from another guild', () =>
  notFound(
    getDiscordMessage(
      getAdapter({ fetch: () => Promise.resolve(message('message-9', 'hello')) }),
      {
        binding,
        scope: 'thread',
        messageUrl: 'https://discord.com/channels/guild-2/channel-1/message-9',
      },
      { resolveChannelPolicy: () => admitted() },
    ),
  ),
)

it.effect('rejects direct message URLs', () =>
  notFound(
    getDiscordMessage(
      getAdapter({ fetch: () => Promise.resolve(message('message-9', 'hello')) }),
      { binding, scope: 'thread', messageUrl: 'https://discord.com/channels/@me/message-9' },
      { resolveChannelPolicy: () => admitted() },
    ),
  ),
)

it.effect('rejects message URLs in channels outside the policy', () =>
  notFound(
    getDiscordMessage(
      getAdapter({ fetch: () => Promise.resolve(message('message-9', 'hello')) }),
      {
        binding,
        scope: 'thread',
        messageUrl: 'https://discord.com/channels/guild-1/channel-1/message-9',
      },
      { resolveChannelPolicy: () => undefined },
    ),
  ),
)

it.effect('rejects message URLs off the discord domain', () =>
  notFound(
    getDiscordMessage(
      getAdapter({ fetch: () => Promise.resolve(message('message-9', 'hello')) }),
      {
        binding,
        scope: 'thread',
        messageUrl: 'https://example.com/channels/guild-1/channel-1/message-9',
      },
      { resolveChannelPolicy: () => admitted() },
    ),
  ),
)

it.effect('collapses failed fetches to a generic not-found', () =>
  notFound(
    getDiscordMessage(
      getAdapter({ fetch: () => Promise.reject(new Error('404')) }),
      { binding, scope: 'thread', messageId: decodeMessageId('message-9') },
      { resolveChannelPolicy: () => admitted() },
    ),
  ),
)

it.effect('requires exactly one of messageUrl or messageId', () =>
  notFound(
    getDiscordMessage(
      getAdapter({ fetch: () => Promise.resolve(message('message-9', 'hello')) }),
      { binding, scope: 'thread' },
      { resolveChannelPolicy: () => admitted() },
    ),
  ),
)
