import { assert, it } from '@effect/vitest'
import { ConversationBinding, InputMessage, ModelSelection } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Logger from 'effect/Logger'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { PlatformThreadRouterError } from '../PlatformThreadRouter.ts'
import { makeDiscordThreadRoute } from './DiscordThreadRouting.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeInputMessage = Schema.decodeSync(InputMessage)
const decodeModelSelection = Schema.decodeSync(ModelSelection)

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const THREAD = '333333333333333333'

const channelConversation = `discord:${GUILD}:${CHANNEL}:${CHANNEL}`

const replyInChannel: DiscordResolvedChannelPolicy = {
  invocationMode: 'mention-only',
  replyMode: 'reply-in-channel',
  users: { mode: 'all', ids: [] },
}

const testUtility = {
  ...decodeModelSelection({ provider: 'utility-provider', modelId: 'utility-model' }),
  thinkingLevel: 'low' as const,
}

const topLevelInput = (): PlatformInput => ({
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
})

const discordStub = () => {
  const createdCalls: Array<{ channelId: string; messageId: string }> = []
  const adapter = {
    decodeThreadId: (threadId: string) => {
      const parts = threadId.split(':')
      return { guildId: parts[1] ?? '', channelId: parts[2] ?? '' }
    },
    encodeThreadId: (data: { guildId: string; channelId: string; threadId?: string }) =>
      `discord:${data.guildId}:${data.channelId}${data.threadId ? `:${data.threadId}` : ''}`,
    createRoutedDiscordThread: (channelId: string, messageId: string) => {
      createdCalls.push({ channelId, messageId })
      return Promise.resolve({ id: THREAD, name: 't' })
    },
  }
  return { ...adapter, createdCalls }
}

interface CapturedLog {
  readonly message: unknown
  readonly annotations: {
    readonly component?: unknown
    readonly channelId?: unknown
    readonly conversationId?: unknown
    readonly errorTag?: unknown
    readonly operation?: unknown
    readonly detail?: unknown
    readonly cause?: unknown
    readonly utilityProvider?: unknown
    readonly utilityModelId?: unknown
    readonly utilityThinkingLevel?: unknown
  }
}

it.effect('logs utility identity and domain detail on routing decision failure', () =>
  Effect.gen(function* () {
    const logs: Array<CapturedLog> = []
    const captureLogger = Logger.map(Logger.formatStructured, (output) => {
      logs.push({ message: output.message, annotations: output.annotations })
    })
    const stub = discordStub()
    const route = makeDiscordThreadRoute({
      discord: stub,
      decide: () =>
        Effect.fail(
          new PlatformThreadRouterError({
            operation: 'thread-route',
            detail: 'routing boom detail',
            cause: new Error('underlying router\nboom'),
          }),
        ),
      resolveChannelPolicy: () => replyInChannel,
      utility: () => testUtility,
    })
    const input = topLevelInput()
    const result = yield* route(input).pipe(
      Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: true })),
    )
    // Fallback preserved: parent input returns unchanged without creation.
    assert.strictEqual(result, input)
    assert.deepStrictEqual(stub.createdCalls, [])

    const failures = logs.filter((log) => log.message === 'thread.route.decision-failed')
    assert.strictEqual(failures.length, 1)
    const annotations = failures[0]?.annotations ?? {}
    assert.strictEqual(annotations.component, 'discord')
    assert.strictEqual(annotations.channelId, CHANNEL)
    assert.strictEqual(annotations.conversationId, channelConversation)
    assert.strictEqual(annotations.errorTag, 'PlatformThreadRouterError')
    assert.strictEqual(annotations.operation, 'thread-route')
    assert.strictEqual(annotations.detail, 'routing boom detail')
    // Safely rendered cause is single-line without raw newlines.
    assert.strictEqual(annotations.cause, 'underlying router boom')
    assert.strictEqual(annotations.utilityProvider, 'utility-provider')
    assert.strictEqual(annotations.utilityModelId, 'utility-model')
    assert.strictEqual(annotations.utilityThinkingLevel, 'low')
    // Arbitrary request content never reaches failure logs.
    assert.notMatch(JSON.stringify(failures), /Please build the feature/u)
  }),
)

it.effect('retains domain detail without utility identity when unavailable', () =>
  Effect.gen(function* () {
    const logs: Array<CapturedLog> = []
    const captureLogger = Logger.map(Logger.formatStructured, (output) => {
      logs.push({ message: output.message, annotations: output.annotations })
    })
    const stub = discordStub()
    const route = makeDiscordThreadRoute({
      discord: stub,
      decide: () =>
        Effect.fail(
          new PlatformThreadRouterError({
            operation: 'thread-route',
            detail: 'boom without utility',
          }),
        ),
      resolveChannelPolicy: () => replyInChannel,
    })
    const input = topLevelInput()
    const result = yield* route(input).pipe(
      Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: true })),
    )
    assert.strictEqual(result, input)
    assert.deepStrictEqual(stub.createdCalls, [])

    const failures = logs.filter((log) => log.message === 'thread.route.decision-failed')
    assert.strictEqual(failures.length, 1)
    const annotations = failures[0]?.annotations ?? {}
    assert.strictEqual(annotations.errorTag, 'PlatformThreadRouterError')
    assert.strictEqual(annotations.operation, 'thread-route')
    assert.strictEqual(annotations.detail, 'boom without utility')
    assert.strictEqual(annotations.utilityProvider, undefined)
    assert.strictEqual(annotations.utilityModelId, undefined)
    assert.notMatch(JSON.stringify(failures), /Please build the feature/u)
  }),
)
