/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, effecttsgo/async-function -- Test doubles narrow the Discord adapter to the decode/encode/create members routing reads. */
import { assert, it } from '@effect/vitest'
import {
  ContextMessage,
  ConversationBinding,
  InputMessage,
  PlatformConversationId,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { PlatformThreadRouterError } from '../PlatformThreadRouter.ts'
import { makeDiscordThreadRoute, rebindToNativeThread } from './DiscordThreadRouting.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeInputMessage = Schema.decodeSync(InputMessage)
const decodeConversationId = Schema.decodeSync(PlatformConversationId)
const decodeContextMessage = Schema.decodeSync(ContextMessage)

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const THREAD = '333333333333333333'

const channelConversation = `discord:${GUILD}:${CHANNEL}:${CHANNEL}`
const threadConversation = `discord:${GUILD}:${CHANNEL}:${THREAD}`

const replyInChannel: DiscordResolvedChannelPolicy = {
  invocationMode: 'mention-only',
  replyMode: 'reply-in-channel',
  users: { mode: 'all', ids: [] },
}
const replyInThread: DiscordResolvedChannelPolicy = {
  ...replyInChannel,
  replyMode: 'reply-in-thread',
}

const topLevelInput = (overrides?: Partial<PlatformInput>): PlatformInput => ({
  binding: decodeBinding({
    platform: 'discord',
    connectionId: 'discord',
    channelId: `discord:${GUILD}:${CHANNEL}`,
    sourceMessageId: 'message-1',
    conversationId: channelConversation,
  }),
  message: decodeInputMessage({
    source: 'user',
    content: { text: 'Please build the feature in a thread', images: [] },
    platformMessageId: 'message-1',
  }),
  initialContext: [],
  discordHistorySource: 'channel',
  ...overrides,
})

const discordStub = (options?: {
  readonly create?: (channelId: string, messageId: string) => Promise<{ id: string; name: string }>
  readonly createdCalls?: Array<{ channelId: string; messageId: string }>
}) => {
  const createdCalls = options?.createdCalls ?? []
  const adapter = {
    decodeThreadId: (threadId: string) => {
      const parts = threadId.split(':')
      const guildId = parts[1] ?? ''
      const channelId = parts[2] ?? ''
      const threadIdPart = parts[3]
      return threadIdPart === undefined
        ? { guildId, channelId }
        : { guildId, channelId, threadId: threadIdPart }
    },
    encodeThreadId: (data: { guildId: string; channelId: string; threadId?: string }) =>
      `discord:${data.guildId}:${data.channelId}${data.threadId ? `:${data.threadId}` : ''}`,
    createRoutedDiscordThread: (channelId: string, messageId: string) => {
      createdCalls.push({ channelId, messageId })
      return options?.create?.(channelId, messageId) ?? Promise.resolve({ id: THREAD, name: 't' })
    },
  }
  return { ...adapter, createdCalls }
}

type StubAdapter = ReturnType<typeof discordStub>
const asRouteAdapter = (stub: StubAdapter) =>
  (({ decodeThreadId, encodeThreadId, createRoutedDiscordThread }) => ({
    decodeThreadId,
    encodeThreadId,
    createRoutedDiscordThread,
  }))(stub)

it.effect('bypasses non-discord and in-thread messages without deciding', () =>
  Effect.gen(function* () {
    let decided = 0
    const stub = discordStub()
    const route = makeDiscordThreadRoute({
      discord: asRouteAdapter(stub),
      decide: () =>
        Effect.sync(() => {
          decided += 1
          return { decision: 'create-thread', reason: 'explicit-request' } as const
        }),
      resolveChannelPolicy: () => replyInChannel,
    })
    const webInput = topLevelInput({
      binding: decodeBinding({
        platform: 'web',
        connectionId: 'web',
        channelId: 'channel-web',
        sourceMessageId: 'message-1',
        conversationId: 'conversation-web',
      }),
    })
    assert.strictEqual(yield* route(webInput), webInput)
    const inThread = topLevelInput({
      binding: decodeBinding({
        platform: 'discord',
        connectionId: 'discord',
        channelId: `discord:${GUILD}:${CHANNEL}`,
        sourceMessageId: 'message-2',
        conversationId: threadConversation,
      }),
      discordHistorySource: 'thread',
    })
    assert.strictEqual(yield* route(inThread), inThread)
    // A manually created thread starter repaired by projection still encodes a
    // thread conversation even though its history source reports channel.
    const repaired = topLevelInput({
      binding: decodeBinding({
        platform: 'discord',
        connectionId: 'discord',
        channelId: `discord:${GUILD}:${CHANNEL}`,
        sourceMessageId: 'message-3',
        conversationId: threadConversation,
      }),
      discordHistorySource: 'channel',
    })
    assert.strictEqual(yield* route(repaired), repaired)
    assert.strictEqual(decided, 0)
  }),
)

it.effect('keeps reply-in-thread channels on the existing path', () =>
  Effect.gen(function* () {
    let decided = 0
    const stub = discordStub()
    const route = makeDiscordThreadRoute({
      discord: asRouteAdapter(stub),
      decide: () =>
        Effect.sync(() => {
          decided += 1
          return { decision: 'create-thread', reason: 'explicit-request' } as const
        }),
      resolveChannelPolicy: () => replyInThread,
    })
    const input = topLevelInput()
    assert.strictEqual(yield* route(input), input)
    assert.strictEqual(decided, 0)
    assert.deepStrictEqual(stub.createdCalls, [])
  }),
)

it.effect('rebinds an explicit thread request to the new native thread', () =>
  Effect.gen(function* () {
    const stub = discordStub()
    const route = makeDiscordThreadRoute({
      discord: asRouteAdapter(stub),
      decide: () =>
        Effect.succeed({ decision: 'create-thread', reason: 'explicit-request' } as const),
      resolveChannelPolicy: () => replyInChannel,
    })
    const input = topLevelInput({
      initialContext: [
        decodeContextMessage({
          author: {
            platformUserId: 'user-2',
            mention: '<@user-2>',
            username: 'other',
            displayName: 'Other',
          },
          content: { text: 'Parent discussion.', images: [] },
          platformMessageId: 'message-0',
        }),
      ],
    })
    const routed = yield* route(input)
    assert.notStrictEqual(routed, input)
    assert.strictEqual(String(routed.binding.conversationId), threadConversation)
    // Source identity, channel identity, attribution, and bounded parent
    // context survive the rebinding; only the conversation moves.
    assert.strictEqual(String(routed.binding.channelId), String(input.binding.channelId))
    assert.strictEqual(String(routed.binding.sourceMessageId), 'message-1')
    assert.strictEqual(String(routed.message.platformMessageId), 'message-1')
    assert.strictEqual(routed.message.content.text, input.message.content.text)
    assert.deepStrictEqual(routed.initialContext, input.initialContext)
    assert.strictEqual(routed.discordHistorySource, 'thread')
    assert.deepStrictEqual(stub.createdCalls, [{ channelId: CHANNEL, messageId: 'message-1' }])
  }),
)

it.effect('rebinds substantial work marked thread-beneficial', () =>
  Effect.gen(function* () {
    const beneficialStub = discordStub()
    const route = makeDiscordThreadRoute({
      discord: asRouteAdapter(beneficialStub),
      decide: () =>
        Effect.succeed({ decision: 'create-thread', reason: 'thread-beneficial' } as const),
      resolveChannelPolicy: () => replyInChannel,
    })
    const routed = yield* route(topLevelInput())
    assert.strictEqual(String(routed.binding.conversationId), threadConversation)
  }),
)

it.effect('keeps conservative messages in the parent channel', () =>
  Effect.gen(function* () {
    const stub = discordStub()
    const route = makeDiscordThreadRoute({
      discord: asRouteAdapter(stub),
      decide: () =>
        Effect.succeed({ decision: 'keep-channel', reason: 'channel-appropriate' } as const),
      resolveChannelPolicy: () => replyInChannel,
    })
    const input = topLevelInput()
    assert.strictEqual(yield* route(input), input)
    assert.deepStrictEqual(stub.createdCalls, [])
  }),
)

it.effect('falls back to the parent on model failure without creating a thread', () =>
  Effect.gen(function* () {
    const stub = discordStub()
    const route = makeDiscordThreadRoute({
      discord: asRouteAdapter(stub),
      decide: () =>
        Effect.fail(new PlatformThreadRouterError({ operation: 'thread-route', detail: 'boom' })),
      resolveChannelPolicy: () => replyInChannel,
    })
    const input = topLevelInput()
    assert.strictEqual(yield* route(input), input)
    assert.deepStrictEqual(stub.createdCalls, [])
  }),
)

it.effect('falls back to the parent on native creation failure without retrying', () =>
  Effect.gen(function* () {
    let attempts = 0
    const stub = discordStub({
      create: () => {
        attempts += 1
        return Promise.reject(new Error('Discord 500'))
      },
    })
    const route = makeDiscordThreadRoute({
      discord: stub,
      decide: () =>
        Effect.succeed({ decision: 'create-thread', reason: 'explicit-request' } as const),
      resolveChannelPolicy: () => replyInChannel,
    })
    const input = topLevelInput()
    assert.strictEqual(yield* route(input), input)
    assert.strictEqual(attempts, 1)
    assert.strictEqual(stub.createdCalls.length, 1)
  }),
)

it.effect('waits for a slow native creation instead of timing out to the parent', () =>
  Effect.gen(function* () {
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    let resolveCreated!: (value: { id: string; name: string }) => void
    const createdGate = new Promise<{ id: string; name: string }>((resolve) => {
      resolveCreated = resolve
    })
    const stub = discordStub({
      create: () => {
        resolveStarted()
        return createdGate
      },
    })
    const route = makeDiscordThreadRoute({
      discord: asRouteAdapter(stub),
      decide: () =>
        Effect.succeed({ decision: 'create-thread', reason: 'explicit-request' } as const),
      resolveChannelPolicy: () => replyInChannel,
    })
    const input = topLevelInput()
    const fiber = yield* route(input).pipe(Effect.forkChild)
    yield* Effect.promise(() => started)
    // Past the old 10-second fail-open window: routing must still be waiting
    // for the single creation result, not answering in the parent.
    yield* TestClock.adjust('10 seconds')
    const pending = yield* Effect.sync(() => fiber.pollUnsafe())
    assert.isTrue(pending === undefined)
    resolveCreated({ id: THREAD, name: 'Slow Thread' })
    const result = yield* Fiber.join(fiber)
    // The late-but-only creation result binds the input; no orphan is possible
    // because the parent fallback never raced the in-flight POST.
    assert.strictEqual(String(result.binding.conversationId), threadConversation)
    assert.strictEqual(stub.createdCalls.length, 1)
  }),
)

it('preserves identity when rebinding without a router', () => {
  const input = topLevelInput()
  const rebound = rebindToNativeThread(input, threadConversation)
  assert.strictEqual(String(rebound.binding.conversationId), threadConversation)
  assert.strictEqual(
    decodeConversationId(String(rebound.binding.conversationId)),
    threadConversation as never,
  )
  assert.strictEqual(String(rebound.binding.sourceMessageId), 'message-1')
  assert.strictEqual(rebound.message.content.text, input.message.content.text)
})
