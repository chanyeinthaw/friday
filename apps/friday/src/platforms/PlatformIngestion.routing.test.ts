/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- Routing tests narrow thread lookups to parent/target conversations. */
import { assert, it } from '@effect/vitest'
import {
  ChannelThread,
  ContextMessage,
  ConversationBinding,
  InputMessage,
  ModelSelection,
  type Thread as ThreadType,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { Friday, type FridayContract } from '../Friday.ts'
import { AppConfig } from '../config/AppConfigLive.ts'
import { TextGeneration } from '../harness/TextGeneration.ts'
import { ChannelProgressLive } from '../conversation/ChannelProgress.ts'
import { ChannelTurnsLive } from '../conversation/ChannelTurns.ts'
import {
  ThreadPersistence,
  type ThreadPersistenceContract,
} from '../conversation/ThreadPersistence.ts'
import type { ThreadCoordinatorContract } from '../conversation/ThreadCoordinator.ts'
import { harnessReloadSucceeded } from '../conversation/ThreadRuntime.ts'
import type { ThreadRuntimeError } from '../conversation/ThreadRuntimes.ts'
import { ConversationTitles } from './ConversationTitles.ts'
import { PlatformIngestion, PlatformIngestionLive } from './PlatformIngestion.ts'
import type { PlatformAdapter, PlatformInput } from './PlatformAdapter.ts'
import { PlatformRegistry, PlatformRegistryLive } from './PlatformRegistry.ts'

const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const THREAD = '333333333333333333'
const parentConversation = `discord:${GUILD}:${CHANNEL}:${CHANNEL}`
const targetConversation = `discord:${GUILD}:${CHANNEL}:${THREAD}`

const parentBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: `discord:${GUILD}:${CHANNEL}`,
  sourceMessageId: 'message-1',
  conversationId: parentConversation,
})
const targetBinding = Schema.decodeSync(ConversationBinding)({
  ...parentBinding,
  conversationId: targetConversation,
})

const parentInput: PlatformInput = {
  binding: parentBinding,
  message: Schema.decodeSync(InputMessage)({
    source: 'user',
    content: { text: 'Please build the feature in a thread', images: [] },
    platformMessageId: 'message-1',
  }),
  initialContext: [],
  discordHistorySource: 'channel',
}
const routedInput: PlatformInput = {
  ...parentInput,
  binding: targetBinding,
  discordHistorySource: 'thread',
}

const parentThread: ThreadType = Schema.decodeSync(ChannelThread)({
  id: 'thread-parent',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-parent',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'Parent channel', description: '' },
  conversationBinding: parentBinding,
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})
const targetThread: ThreadType = Schema.decodeSync(ChannelThread)({
  ...parentThread,
  id: 'thread-target',
  workingDirectory: '/tmp/friday/thread-target',
  conversationBinding: targetBinding,
})

const decodeParentContext = Schema.decodeSync(ContextMessage)
const testModel = Schema.decodeSync(ModelSelection)({
  provider: 'opencode-go',
  modelId: 'deepseek-v4-flash',
})
const testConfig = {
  installationId: 'test-installation',
  models: {
    primary: { ...testModel, thinkingLevel: 'max' as const },
    utility: { ...testModel, thinkingLevel: 'low' as const },
    subagents: [],
  },
  platforms: { discord: [], slack: [] },
  agent: { recentMessageCount: 20 },
  admin: { discordUserIds: [] },
} as const
const testAppConfig = AppConfig.of({
  current: () => testConfig,
  reload: Effect.die('reload is not expected in routing tests'),
})
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
})

interface RoutingHarness {
  readonly lookups: Array<string>
  readonly createdInputs: Array<PlatformInput>
  readonly acceptedThreads: Array<string>
  readonly platformEvents: Array<string>
  readonly routeCalls: Array<string>
}

const runIngestion = (
  harness: RoutingHarness,
  options: {
    readonly parentThread?: ThreadType | null
    readonly targetThread?: ThreadType | null
    readonly route?: (input: PlatformInput) => Effect.Effect<PlatformInput>
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const persistence = makePersistence(harness, options)
      const friday = makeFriday(harness)
      const platform = makePlatform(harness)
      const dependencies = Layer.mergeAll(
        Layer.succeed(ThreadPersistence, persistence),
        Layer.succeed(Friday, friday),
        Layer.succeed(Crypto.Crypto, testCrypto),
        Layer.succeed(AppConfig, testAppConfig),
        Layer.succeed(
          TextGeneration,
          TextGeneration.of({ generateThreadTitle: () => Effect.succeed('Routed Thread') }),
        ),
        Layer.succeed(
          ConversationTitles,
          ConversationTitles.of({
            generated: () => Effect.void,
            taskStarted: () => Effect.void,
            taskFinished: () => Effect.void,
          }),
        ),
        PlatformRegistryLive,
      )
      const ProgressLive = ChannelProgressLive.pipe(Layer.provide(dependencies))
      const TurnsLive = ChannelTurnsLive.pipe(
        Layer.provide(Layer.merge(dependencies, ProgressLive)),
      )
      const TestLive = Layer.merge(
        Layer.mergeAll(dependencies, ProgressLive, TurnsLive),
        PlatformIngestionLive.pipe(Layer.provide(Layer.merge(dependencies, TurnsLive))),
      )
      yield* Effect.gen(function* () {
        const ingestion = yield* PlatformIngestion
        const platforms = yield* PlatformRegistry
        yield* platforms.register(platform)
        yield* ingestion.ingest(
          parentInput,
          (candidate) =>
            Effect.sync(() => {
              harness.createdInputs.push(candidate)
              if (options.targetThread !== undefined && options.targetThread !== null) {
                return options.targetThread
              }
              return targetThread
            }),
          (current) => Effect.succeed(current),
          options.route,
        )
      }).pipe(Effect.provide(TestLive))
    }),
  )

const makePlatform = (harness: RoutingHarness): PlatformAdapter<never> => ({
  connectionId: parentBinding.connectionId,
  kind: 'discord',
  publish: ({ binding, text }) =>
    Effect.sync(() =>
      harness.platformEvents.push(`publish:${String(binding.conversationId)}:${text}`),
    ),
  acknowledge: ({ binding, messageId }) =>
    Effect.sync(() =>
      harness.platformEvents.push(`acknowledge:${String(binding.conversationId)}:${messageId}`),
    ),
  beginWorking: ({ binding, text }) =>
    Effect.sync(() =>
      harness.platformEvents.push(`working:${String(binding.conversationId)}:${text}`),
    ),
  updateWorking: ({ text }) => Effect.sync(() => harness.platformEvents.push(`update:${text}`)),
  setAgentActivity: () => Effect.void,
  searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
  setConversationTitle: () => Effect.void,
  discardWorking: () => Effect.void,
  finalizeWorking: ({ binding, text }) =>
    Effect.sync(() =>
      harness.platformEvents.push(`finalize:${String(binding.conversationId)}:${text}`),
    ),
  withTyping: (_binding, effect) => effect,
})

const makeFriday = (harness: RoutingHarness): FridayContract => ({
  openThread: (thread) =>
    Effect.sync(() => {
      harness.acceptedThreads.push(thread.id)
      return {
        prompt: (turn) =>
          Effect.succeed({
            turnId: turn.id,
            awaitTerminal: Effect.succeed({
              status: 'completed' as const,
              turnId: turn.id,
              agentMessage: 'Friday is done.',
              usage: null,
            }),
          }),
        steer: () => Effect.void,
        cancel: () => Effect.void,
        reload: () => Effect.succeed(harnessReloadSucceeded()),
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.void,
      } satisfies ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>
    }),
})

const makePersistence = (
  harness: RoutingHarness,
  options: { readonly parentThread?: ThreadType | null; readonly targetThread?: ThreadType | null },
): ThreadPersistenceContract => {
  const parent = options.parentThread === undefined ? parentThread : options.parentThread
  const target = options.targetThread === undefined ? null : options.targetThread
  return {
    createThread: () => Effect.void,
    getThread: () => Effect.succeedNone,
    findPlatformThread: (lookup) =>
      Effect.sync(() => {
        harness.lookups.push(String(lookup.conversationId))
        if (String(lookup.conversationId) === parentConversation) {
          return parent === null ? Option.none() : Option.some(parent)
        }
        return target === null ? Option.none() : Option.some(target)
      }),
    listAgentThreads: () => Effect.succeed([]),
    closeThread: () => Effect.void,
    setThreadHarnessSession: () => Effect.void,
    createTurn: () => Effect.void,
    getTurn: () => Effect.succeedNone,
    getFirstTurn: () => Effect.succeedNone,
    getLatestTurn: () => Effect.succeedNone,
    getLatestUserTurn: () => Effect.succeedNone,
    startTurn: () => Effect.void,
    putActivitySnapshot: () => Effect.void,
    getActivity: () => Effect.succeedNone,
    completeTurn: () => Effect.void,
    interruptTurn: () => Effect.void,
    failTurn: () => Effect.void,
  }
}

const freshHarness = (): RoutingHarness => ({
  lookups: [],
  createdInputs: [],
  acceptedThreads: [],
  platformEvents: [],
  routeCalls: [],
})

it.effect('keeps the parent binding when routing returns the input unchanged', () =>
  Effect.gen(function* () {
    const harness = freshHarness()
    yield* runIngestion(harness, {
      parentThread,
      targetThread: null,
      route: (input) =>
        Effect.sync(() => {
          harness.routeCalls.push(String(input.binding.conversationId))
          return input
        }),
    })
    assert.deepStrictEqual(harness.routeCalls, [parentConversation])
    assert.deepStrictEqual(harness.lookups, [parentConversation])
    assert.deepStrictEqual(harness.acceptedThreads, ['thread-parent'])
    assert.deepStrictEqual(harness.createdInputs, [])
    assert.isTrue(
      harness.platformEvents.some((event) =>
        event.startsWith(`acknowledge:${parentConversation}:`),
      ),
    )
    assert.isTrue(
      harness.platformEvents.some((event) => event.startsWith(`finalize:${parentConversation}:`)),
    )
  }),
)

it.effect('looks up the routed target after the parent and never reuses the parent', () =>
  Effect.gen(function* () {
    const harness = freshHarness()
    yield* runIngestion(harness, {
      parentThread,
      targetThread: null,
      route: (input) =>
        Effect.sync(() => {
          harness.routeCalls.push(String(input.binding.conversationId))
          return routedInput
        }),
    })
    // Fresh target lookup follows the parent lookup in order.
    assert.deepStrictEqual(harness.routeCalls, [parentConversation])
    assert.deepStrictEqual(harness.lookups, [parentConversation, targetConversation])
    // The parent Friday thread is not reused; the target is created and accepted.
    assert.deepStrictEqual(harness.acceptedThreads, ['thread-target'])
    assert.strictEqual(harness.createdInputs.length, 1)
    assert.strictEqual(String(harness.createdInputs[0]?.binding.conversationId), targetConversation)
    // Source identity and channel identity survive rebinding.
    assert.strictEqual(String(harness.createdInputs[0]?.binding.sourceMessageId), 'message-1')
    assert.strictEqual(
      String(harness.createdInputs[0]?.binding.channelId),
      String(parentBinding.channelId),
    )
    // Working and final output target the native thread, with no parent notice.
    assert.isTrue(
      harness.platformEvents.some((event) => event.startsWith(`working:${targetConversation}:`)),
    )
    assert.isTrue(
      harness.platformEvents.some((event) => event.startsWith(`finalize:${targetConversation}:`)),
    )
    assert.isFalse(
      harness.platformEvents.some((event) => event.includes(`publish:${parentConversation}:`)),
    )
    assert.isFalse(
      harness.platformEvents.some((event) => event.startsWith(`finalize:${parentConversation}:`)),
    )
  }),
)

it.effect('reuses an existing target thread without creating another', () =>
  Effect.gen(function* () {
    const harness = freshHarness()
    yield* runIngestion(harness, {
      parentThread,
      targetThread,
      route: () => Effect.succeed(routedInput),
    })
    assert.deepStrictEqual(harness.lookups, [parentConversation, targetConversation])
    assert.deepStrictEqual(harness.acceptedThreads, ['thread-target'])
    assert.deepStrictEqual(harness.createdInputs, [])
  }),
)

it.effect('calls routing once and never re-ingests the rebound input', () =>
  Effect.gen(function* () {
    const harness = freshHarness()
    let calls = 0
    yield* runIngestion(harness, {
      parentThread: null,
      targetThread: null,
      route: (input) =>
        Effect.sync(() => {
          calls += 1
          harness.routeCalls.push(String(input.binding.conversationId))
          // Only the first call routes; a recursive call would see the target
          // conversation and route again.
          return calls === 1 ? routedInput : input
        }),
    })
    assert.strictEqual(calls, 1)
    assert.deepStrictEqual(harness.routeCalls, [parentConversation])
    assert.deepStrictEqual(harness.lookups, [parentConversation, targetConversation])
  }),
)

it.effect('seeds the routed turn with bounded parent-channel context', () =>
  Effect.gen(function* () {
    const harness = freshHarness()
    const contexts: Array<TurnType['input']['context']> = []
    const persistence = makePersistence(harness, { parentThread: null, targetThread: null })
    const friday: FridayContract = {
      openThread: (thread) =>
        Effect.sync(() => {
          harness.acceptedThreads.push(thread.id)
          return {
            prompt: (turn) =>
              Effect.sync(() => void contexts.push(turn.input.context)).pipe(
                Effect.as({
                  turnId: turn.id,
                  awaitTerminal: Effect.succeed({
                    status: 'completed' as const,
                    turnId: turn.id,
                    agentMessage: 'done',
                    usage: null,
                  }),
                }),
              ),
            steer: () => Effect.void,
            cancel: () => Effect.void,
            reload: () => Effect.succeed(harnessReloadSucceeded()),
            onEvent: () => Effect.void,
            start: Effect.void,
            drain: Effect.void,
          } satisfies ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>
        }),
    }
    const platform = makePlatform(harness)
    const parentWithContext: PlatformInput = {
      ...parentInput,
      initialContext: [
        decodeParentContext({
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
    }
    const dependencies = Layer.mergeAll(
      Layer.succeed(ThreadPersistence, persistence),
      Layer.succeed(Friday, friday),
      Layer.succeed(Crypto.Crypto, testCrypto),
      Layer.succeed(AppConfig, testAppConfig),
      Layer.succeed(
        TextGeneration,
        TextGeneration.of({ generateThreadTitle: () => Effect.succeed('T') }),
      ),
      Layer.succeed(
        ConversationTitles,
        ConversationTitles.of({
          generated: () => Effect.void,
          taskStarted: () => Effect.void,
          taskFinished: () => Effect.void,
        }),
      ),
      PlatformRegistryLive,
    )
    const ProgressLive = ChannelProgressLive.pipe(Layer.provide(dependencies))
    const TurnsLive = ChannelTurnsLive.pipe(Layer.provide(Layer.merge(dependencies, ProgressLive)))
    const TestLive = Layer.merge(
      Layer.mergeAll(dependencies, ProgressLive, TurnsLive),
      PlatformIngestionLive.pipe(Layer.provide(Layer.merge(dependencies, TurnsLive))),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const ingestion = yield* PlatformIngestion
        const platforms = yield* PlatformRegistry
        yield* platforms.register(platform)
        yield* ingestion.ingest(
          parentWithContext,
          (candidate) =>
            Effect.succeed({ ...targetThread, conversationBinding: candidate.binding }),
          (current) => Effect.succeed(current),
          (enriched) =>
            Effect.succeed({
              ...enriched,
              binding: targetBinding,
              discordHistorySource: 'thread' as const,
            }),
        )
      }).pipe(Effect.provide(TestLive)),
    )
    assert.strictEqual(contexts.length, 1)
    const seeded = contexts[0]
    assert.isDefined(seeded)
    assert.strictEqual(seeded.length, 1)
    assert.strictEqual(seeded[0]?.content.text, 'Parent discussion.')
  }),
)
