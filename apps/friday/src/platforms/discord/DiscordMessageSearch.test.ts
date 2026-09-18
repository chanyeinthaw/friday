import { assert, it } from '@effect/vitest'
import { ConversationBinding, PlatformMessageId } from '@friday/contracts/conversation'
import { Message } from 'chat'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { DiscordThreadId } from '@chat-adapter/discord'
import {
  DiscordMaxPostLength,
  getDiscordMessage,
  postDiscordMessage,
  searchDiscordMessages,
  type DiscordMessageQueryAdapter,
  type DiscordMessageQueryPolicy,
} from './DiscordMessageSearch.ts'
import {
  PlatformMessageNotFoundError,
  PlatformTargetNotFoundError,
  type DiscordQueryTarget,
} from '../PlatformAdapter.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

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

const decodeMessageId = Schema.decodeSync(PlatformMessageId)
const isTargetNotFound = Schema.is(PlatformTargetNotFoundError)
const isMessageNotFound = Schema.is(PlatformMessageNotFoundError)
const isPublicationError = Schema.is(ChatSdkPublicationError)

const admitted = (): DiscordResolvedChannelPolicy => ({
  invocationMode: 'mention-only',
  replyMode: 'reply-in-thread',
  users: { mode: 'all', ids: [] },
})

/** Admits exactly the `guild:channel` pairs listed; everything else fails closed. */
const policyFor = (admittedPairs: ReadonlyArray<string>): DiscordMessageQueryPolicy => ({
  resolveChannelPolicy: (guildId, channelId) =>
    admittedPairs.includes(`${guildId}:${channelId}`) ? admitted() : undefined,
})

const channelTarget = (guildId = 'guild-1', channelId = 'channel-1'): DiscordQueryTarget => ({
  platform: 'discord',
  guildId,
  channelId,
})

const threadTarget = (
  threadId: string,
  channelId?: string,
  guildId = 'guild-1',
): DiscordQueryTarget => {
  const target: DiscordQueryTarget = { platform: 'discord', guildId, threadId }
  if (channelId !== undefined) return { ...target, channelId }
  return target
}

interface StubOptions {
  readonly channelRaw?: unknown
  readonly messages?: ReadonlyArray<Message>
  readonly fetch?: (channelId: string, messageId: string) => Promise<Message>
  readonly posted?: Array<{ readonly address: string; readonly text: string }>
  readonly postId?: string | null
}

const stubAdapter = (options: StubOptions = {}): DiscordMessageQueryAdapter => ({
  decodeThreadId: (id: string): DiscordThreadId => {
    const [, guildId, channelId, threadId] = id.split(':')
    if (guildId === undefined || channelId === undefined) {
      throw new Error(`Malformed Discord conversation id: ${id}`)
    }
    return threadId === undefined ? { guildId, channelId } : { guildId, channelId, threadId }
  },
  encodeThreadId: ({ guildId, channelId, threadId }: DiscordThreadId) =>
    threadId === undefined
      ? `discord:${guildId}:${channelId}`
      : `discord:${guildId}:${channelId}:${threadId}`,
  fetchMessages: () => Promise.resolve({ messages: [...(options.messages ?? [])] }),
  fetchChannelInfo: (channelId: string) =>
    Promise.resolve({ id: channelId, metadata: { raw: options.channelRaw ?? {} } }),
  fetchDirectMessage: options.fetch ?? (() => Promise.reject(new Error('unexpected fetch'))),
  postMessage: (address: string, text: string) => {
    options.posted?.push({ address, text })
    return Promise.resolve({ id: options.postId ?? 'posted-1', threadId: address, raw: {} })
  },
  postChannelMessage: (address: string, text: string) => {
    options.posted?.push({ address, text })
    return Promise.resolve({ id: options.postId ?? 'posted-1', threadId: address, raw: {} })
  },
})

const targetNotFoundMessage = 'Target not found or not accessible.'

it.effect('searches a cross-guild channel target admitted on this connection', () =>
  Effect.gen(function* () {
    const sources: Array<string> = []
    const adapter = stubAdapter({
      messages: [message('message-1', 'Dokploy deploy failed', 'user-1')],
    })
    const seen = adapter.fetchMessages
    const recording: DiscordMessageQueryAdapter = {
      ...adapter,
      fetchMessages: (source, fetchOptions) => {
        sources.push(source)
        return seen(source, fetchOptions)
      },
    }
    const result = yield* searchDiscordMessages(
      recording,
      {
        binding,
        target: channelTarget('guild-2', 'channel-9'),
        query: 'dokploy',
        limit: 20,
      },
      policyFor(['guild-2:channel-9']),
    )

    assert.deepStrictEqual(sources, ['discord:guild-2:channel-9:channel-9'])
    assert.strictEqual(result.messages.length, 1)
    assert.strictEqual(result.messages[0]?.text, 'Dokploy deploy failed')
  }),
)

it.effect('searches a thread target through its parent channel policy', () =>
  Effect.gen(function* () {
    const sources: Array<string> = []
    const lookups: Array<[string, string]> = []
    const adapter = stubAdapter({
      channelRaw: { id: 'thread-1', parent_id: 'channel-1', type: 11 },
      messages: [message('message-1', 'hello', 'user-1')],
    })
    const seen = adapter.fetchMessages
    const recording: DiscordMessageQueryAdapter = {
      ...adapter,
      fetchMessages: (source, fetchOptions) => {
        sources.push(source)
        return seen(source, fetchOptions)
      },
    }
    const result = yield* searchDiscordMessages(
      recording,
      { binding, target: threadTarget('thread-1'), limit: 20 },
      {
        resolveChannelPolicy: (guildId, channelId) => {
          lookups.push([guildId, channelId])
          return admitted()
        },
      },
    )

    assert.deepStrictEqual(lookups, [['guild-1', 'channel-1']])
    assert.deepStrictEqual(sources, ['discord:guild-1:channel-1:thread-1'])
    assert.strictEqual(result.messages.length, 1)
  }),
)

it.effect('fails closed for unadmitted search targets without exposing existence', () =>
  Effect.gen(function* () {
    const error = yield* searchDiscordMessages(
      stubAdapter({ messages: [message('message-1', 'hello')] }),
      { binding, target: channelTarget('guild-1', 'secret-channel'), limit: 20 },
      policyFor(['guild-1:channel-1']),
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
    assert.strictEqual(error.message, targetNotFoundMessage)
  }),
)

it.effect('rejects thread targets whose parent hint disagrees', () =>
  Effect.gen(function* () {
    const error = yield* searchDiscordMessages(
      stubAdapter({ channelRaw: { id: 'thread-1', parent_id: 'channel-1', type: 11 } }),
      { binding, target: threadTarget('thread-1', 'other-channel'), limit: 20 },
      policyFor(['guild-1:channel-1', 'guild-1:other-channel']),
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
  }),
)

it.effect('rejects thread targets that address a plain channel', () =>
  Effect.gen(function* () {
    const error = yield* searchDiscordMessages(
      stubAdapter({ channelRaw: { id: 'channel-1', type: 0 } }),
      { binding, target: threadTarget('channel-1'), limit: 20 },
      policyFor(['guild-1:channel-1']),
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
  }),
)

it.effect('rejects direct-message search targets', () =>
  Effect.gen(function* () {
    const error = yield* searchDiscordMessages(
      stubAdapter(),
      {
        binding,
        target: { platform: 'discord', guildId: '@me', channelId: 'dm-1' },
        limit: 20,
      },
      policyFor(['@me:dm-1']),
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
  }),
)

it.effect('passes the before cursor through to history reads', () =>
  Effect.gen(function* () {
    const cursors: Array<string | undefined> = []
    const adapter = stubAdapter({ messages: [] })
    const recording: DiscordMessageQueryAdapter = {
      ...adapter,
      fetchMessages: (source, fetchOptions) => {
        cursors.push(fetchOptions?.cursor)
        return adapter.fetchMessages(source, fetchOptions)
      },
    }
    yield* searchDiscordMessages(
      recording,
      { binding, target: channelTarget(), limit: 20, before: decodeMessageId('message-5') },
      policyFor(['guild-1:channel-1']),
    )

    assert.deepStrictEqual(cursors, ['message-5'])
  }),
)

it.effect('retrieves a bare message id against an explicit channel target', () =>
  Effect.gen(function* () {
    const fetches: Array<[string, string]> = []
    const result = yield* getDiscordMessage(
      stubAdapter({
        fetch: (channelId, messageId) => {
          fetches.push([channelId, messageId])
          return Promise.resolve(message('message-9', 'hello'))
        },
      }),
      { binding, target: channelTarget(), messageId: decodeMessageId('message-9') },
      policyFor(['guild-1:channel-1']),
    )

    assert.deepStrictEqual(fetches, [['channel-1', 'message-9']])
    assert.strictEqual(result.message.id, 'message-9')
    assert.strictEqual(result.message.sentAt, '2026-03-21T09:00:00.000Z')
  }),
)

it.effect('retrieves a bare message id against a cross-guild thread target', () =>
  Effect.gen(function* () {
    const fetches: Array<[string, string]> = []
    const lookups: Array<[string, string]> = []
    const result = yield* getDiscordMessage(
      stubAdapter({
        channelRaw: { id: 'thread-9', parent_id: 'channel-9', type: 12 },
        fetch: (channelId, messageId) => {
          fetches.push([channelId, messageId])
          return Promise.resolve(message('message-9', 'hello'))
        },
      }),
      {
        binding,
        target: threadTarget('thread-9', undefined, 'guild-2'),
        messageId: decodeMessageId('message-9'),
      },
      {
        resolveChannelPolicy: (guildId, channelId) => {
          lookups.push([guildId, channelId])
          return guildId === 'guild-2' && channelId === 'channel-9' ? admitted() : undefined
        },
      },
    )

    assert.deepStrictEqual(lookups, [['guild-2', 'channel-9']])
    assert.deepStrictEqual(fetches, [['thread-9', 'message-9']])
    assert.strictEqual(result.message.id, 'message-9')
  }),
)

it.effect('requires a target for bare message ids', () =>
  Effect.gen(function* () {
    const error = yield* getDiscordMessage(
      stubAdapter({ fetch: () => Promise.resolve(message('message-9', 'hello')) }),
      { binding, messageId: decodeMessageId('message-9') },
      policyFor(['guild-1:channel-1']),
    ).pipe(Effect.flip)

    assert(isMessageNotFound(error))
    assert.strictEqual(error.message, 'Message not found.')
  }),
)

it.effect('fetches a message URL in an admitted channel and preserves bot authors', () =>
  Effect.gen(function* () {
    const result = yield* getDiscordMessage(
      stubAdapter({ fetch: () => Promise.resolve(message('message-9', 'beep', 'bot-1', true)) }),
      {
        binding,
        messageUrl: 'https://discord.com/channels/guild-1/channel-1/message-9',
      },
      policyFor(['guild-1:channel-1']),
    )

    assert.strictEqual(result.message.id, 'message-9')
    assert.strictEqual(result.message.author.platformUserId, 'bot-1')
  }),
)

it.effect('accepts a URL when the explicit target agrees with it', () =>
  Effect.gen(function* () {
    const result = yield* getDiscordMessage(
      stubAdapter({ fetch: () => Promise.resolve(message('message-9', 'hello')) }),
      {
        binding,
        target: channelTarget(),
        messageUrl: 'https://discord.com/channels/guild-1/channel-1/message-9',
      },
      policyFor(['guild-1:channel-1']),
    )

    assert.strictEqual(result.message.id, 'message-9')
  }),
)

it.effect('rejects a URL when the explicit target disagrees', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({ fetch: () => Promise.resolve(message('message-9', 'hello')) })
    const policy = policyFor(['guild-1:channel-1', 'guild-1:channel-2'])

    for (const target of [
      channelTarget('guild-1', 'channel-2'),
      channelTarget('guild-2', 'channel-1'),
      threadTarget('thread-9'),
    ]) {
      const error = yield* getDiscordMessage(
        adapter,
        {
          binding,
          target,
          messageUrl: 'https://discord.com/channels/guild-1/channel-1/message-9',
        },
        policy,
      ).pipe(Effect.flip)
      assert(isMessageNotFound(error))
    }
  }),
)

const notFoundGet = (
  adapter: DiscordMessageQueryAdapter,
  query: Parameters<typeof getDiscordMessage>[1],
  policy: DiscordMessageQueryPolicy,
) =>
  Effect.gen(function* () {
    const error = yield* getDiscordMessage(adapter, query, policy).pipe(Effect.flip)
    assert(isMessageNotFound(error))
    assert.strictEqual(error.message, 'Message not found.')
  })

it.effect('inherits the parent channel policy for thread URLs', () =>
  Effect.gen(function* () {
    const lookups: Array<[string, string]> = []
    yield* getDiscordMessage(
      stubAdapter({
        channelRaw: { id: 'thread-9', parent_id: 'channel-1', type: 11 },
        fetch: () => Promise.resolve(message('message-9', 'hello')),
      }),
      {
        binding,
        messageUrl: 'https://discord.com/channels/guild-1/thread-9/message-9',
      },
      {
        resolveChannelPolicy: (guildId, channelId) => {
          lookups.push([guildId, channelId])
          return admitted()
        },
      },
    )

    assert.deepStrictEqual(lookups, [['guild-1', 'channel-1']])
  }),
)

it.effect('rejects message URLs from another guild, DMs, or outside the policy', () =>
  Effect.gen(function* () {
    const fetchable = stubAdapter({ fetch: () => Promise.resolve(message('m', 'hello')) })
    yield* notFoundGet(
      fetchable,
      { binding, messageUrl: 'https://discord.com/channels/guild-2/channel-1/m' },
      policyFor(['guild-1:channel-1']),
    )
    yield* notFoundGet(
      fetchable,
      { binding, messageUrl: 'https://discord.com/channels/@me/channel-1/m' },
      policyFor(['guild-1:channel-1']),
    )
    yield* notFoundGet(
      fetchable,
      { binding, messageUrl: 'https://discord.com/channels/guild-1/channel-1/m' },
      policyFor(['guild-1:other']),
    )
    yield* notFoundGet(
      stubAdapter({ fetch: () => Promise.reject(new Error('404')) }),
      { binding, target: channelTarget(), messageId: decodeMessageId('message-9') },
      policyFor(['guild-1:channel-1']),
    )
  }),
)

it.effect('posts one message to a channel target and returns the native id', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    const result = yield* postDiscordMessage(
      stubAdapter({ posted, postId: 'posted-7' }),
      { binding, target: channelTarget(), text: 'hello channel' },
      policyFor(['guild-1:channel-1']),
    )

    assert.deepStrictEqual(posted, [
      { address: 'discord:guild-1:channel-1', text: 'hello channel' },
    ])
    assert.strictEqual(result.messageId, 'posted-7')
  }),
)

it.effect('posts one message to a thread target through the thread address', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    const result = yield* postDiscordMessage(
      stubAdapter({
        channelRaw: { id: 'thread-1', parent_id: 'channel-1', type: 11 },
        posted,
        postId: 'posted-8',
      }),
      { binding, target: threadTarget('thread-1'), text: 'hello thread' },
      policyFor(['guild-1:channel-1']),
    )

    assert.deepStrictEqual(posted, [
      { address: 'discord:guild-1:channel-1:thread-1', text: 'hello thread' },
    ])
    assert.strictEqual(result.messageId, 'posted-8')
  }),
)

it.effect('denies posts to unadmitted targets without posting', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    const error = yield* postDiscordMessage(
      stubAdapter({ posted }),
      { binding, target: channelTarget('guild-1', 'secret'), text: 'hello' },
      policyFor(['guild-1:channel-1']),
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
    assert.strictEqual(error.message, targetNotFoundMessage)
    assert.deepStrictEqual(posted, [])
  }),
)

it.effect('rejects empty and over-limit post text without posting', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    const adapter = stubAdapter({ posted })
    const policy = policyFor(['guild-1:channel-1'])

    const empty = yield* postDiscordMessage(
      adapter,
      { binding, target: channelTarget(), text: '   ' },
      policy,
    ).pipe(Effect.flip)
    assert(isPublicationError(empty))

    const over = yield* postDiscordMessage(
      adapter,
      { binding, target: channelTarget(), text: 'x'.repeat(DiscordMaxPostLength + 1) },
      policy,
    ).pipe(Effect.flip)
    assert(isPublicationError(over))
    assert.deepStrictEqual(posted, [])
  }),
)

it.effect('returns a null id when the transport exposes none', () =>
  Effect.gen(function* () {
    const adapter: DiscordMessageQueryAdapter = {
      ...stubAdapter(),
      postChannelMessage: () => Promise.resolve({ id: '', threadId: 'x', raw: {} }),
    }
    const result = yield* postDiscordMessage(
      adapter,
      { binding, target: channelTarget(), text: 'hello' },
      policyFor(['guild-1:channel-1']),
    )

    assert.strictEqual(result.messageId, null)
  }),
)

const htmlAttachmentMessage = (id: string, text: string, userId: string, isBot: boolean) =>
  new Message({
    id,
    threadId: 'discord:guild-1:channel-1:thread-1',
    text,
    formatted: { type: 'root', children: [] },
    raw: {
      attachments: [
        {
          id: 'html-1',
          filename: 'page.html',
          content_type: 'text/html',
          size: 1024,
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/page.html',
        },
      ],
    },
    author: { userId, userName: userId, fullName: userId, isBot, isMe: false },
    metadata: { dateSent: new Date('2026-03-21T09:00:00.000Z'), edited: false },
    attachments: [],
  })

it.effect('preserves attachment metadata through search and get', () =>
  Effect.gen(function* () {
    const searched = yield* searchDiscordMessages(
      stubAdapter({
        messages: [htmlAttachmentMessage('message-7', 'see report', 'user-1', false)],
      }),
      { binding, target: channelTarget(), query: 'report', limit: 20 },
      policyFor(['guild-1:channel-1']),
    )
    assert.strictEqual(searched.messages[0]?.attachments[0]?.name, 'page.html')

    const fetched = yield* getDiscordMessage(
      stubAdapter({
        fetch: () => Promise.resolve(htmlAttachmentMessage('message-9', 'report', 'bot-1', true)),
      }),
      { binding, target: channelTarget(), messageId: decodeMessageId('message-9') },
      policyFor(['guild-1:channel-1']),
    )
    assert.strictEqual(fetched.message.attachments[0]?.mediaType, 'text/html')
    assert.strictEqual(
      fetched.message.attachments[0]?.storageReference,
      'https://cdn.discordapp.com/attachments/channel/attachment/page.html',
    )
  }),
)

it.effect('requires exactly one of messageUrl or messageId', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({ fetch: () => Promise.resolve(message('m', 'hello')) })
    const policy = policyFor(['guild-1:channel-1'])
    yield* notFoundGet(adapter, { binding, target: channelTarget() }, policy)
    yield* notFoundGet(
      adapter,
      {
        binding,
        target: channelTarget(),
        messageUrl: 'https://discord.com/channels/guild-1/channel-1/m',
        messageId: decodeMessageId('m'),
      },
      policy,
    )
  }),
)
