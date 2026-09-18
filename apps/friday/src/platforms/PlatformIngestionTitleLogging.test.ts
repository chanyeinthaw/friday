import { assert, it } from '@effect/vitest'
import {
  ChannelThread,
  ConversationBinding,
  InputMessage,
  ModelSelection,
  type Thread as ThreadType,
} from '@friday/contracts/conversation'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Schema from 'effect/Schema'

import { Friday, type FridayContract } from '../Friday.ts'
import { AppConfig } from '../config/AppConfigLive.ts'
import { TextGeneration, TextGenerationError } from '../harness/TextGeneration.ts'
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
import type { PlatformInput, PlatformRegistration } from './PlatformAdapter.ts'
import { PlatformRegistry, PlatformRegistryLive } from './PlatformRegistry.ts'

const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'discord:guild-1:channel-1:thread-1',
})
const input: PlatformInput = {
  binding,
  message: Schema.decodeSync(InputMessage)({
    source: 'user',
    content: { text: 'Hello Friday title check', images: [] },
    platformMessageId: 'message-1',
  }),
}
const thread: ThreadType = Schema.decodeSync(ChannelThread)({
  id: 'thread-title-logging',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-title-logging',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'Friday test channel', description: '' },
  conversationBinding: binding,
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

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
  reload: Effect.die('reload is not expected in title logging tests'),
})
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
})

// Lets a detached title sidecar finish: its work is immediate, so a short
// real delay is enough. Effect.sleep uses the test clock here, which never
// advances on its own, hence a real timer kept local to this focused test.
/* oxlint-disable effecttsgo/global-timers, effecttsgo/new-promise -- Focused async-sidecar test needs real time; production code uses Effect timers. */
const settleTitleSidecar = Effect.tryPromise({
  try: () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
  catch: () => 'delay-failed' as const,
}).pipe(Effect.orElseSucceed(() => undefined))

interface CapturedLog {
  readonly message: unknown
  readonly annotations: {
    readonly threadId?: unknown
    readonly errorTag?: unknown
    readonly operation?: unknown
    readonly detail?: unknown
    readonly cause?: unknown
    readonly utilityProvider?: unknown
    readonly utilityModelId?: unknown
    readonly utilityThinkingLevel?: unknown
  }
}

it.effect('logs utility identity and domain detail on title generation failure', () =>
  Effect.gen(function* () {
    const logs: Array<CapturedLog> = []
    const captureLogger = Logger.map(Logger.formatStructured, (output) => {
      logs.push({ message: output.message, annotations: output.annotations })
    })
    const events: Array<string> = []
    const persistence: ThreadPersistenceContract = {
      createThread: () => Effect.void,
      getThread: () => Effect.succeedNone,
      findPlatformThread: () => Effect.succeedNone,
      listAgentThreads: () => Effect.succeed([]),
      closeThread: () => Effect.void,
      setThreadHarnessSession: () => Effect.void,
      setThreadModel: () => Effect.void,
      createTurn: () => Effect.void,
      getTurn: () => Effect.succeedNone,
      getFirstTurn: () => Effect.succeedNone,
      getLatestTurn: () => Effect.succeedNone,
      listTurns: () => Effect.succeed([]),
      getLatestUserTurn: () => Effect.succeedNone,
      startTurn: () => Effect.void,
      putActivitySnapshot: () => Effect.void,
      getActivity: () => Effect.succeedNone,
      completeTurn: () => Effect.void,
      interruptTurn: () => Effect.void,
      failTurn: () => Effect.void,
    }
    const friday: FridayContract = {
      openThread: () =>
        Effect.succeed({
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
        } satisfies ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>),
      observeRuntime: () => Effect.succeed({ runtimePresent: false, activeTurns: 0 }),
    }
    const platform: PlatformRegistration<never> = {
      connectionId: binding.connectionId,
      kind: 'discord',
      publish: () => Effect.void,
      acknowledge: () => Effect.void,
      workingMessages: {
        begin: () => Effect.void,
        update: () => Effect.void,
        discard: () => Effect.void,
        finalize: () => Effect.void,
      },
      withTyping: (_binding, effect) => effect,
    }
    const dependencies = Layer.mergeAll(
      Layer.succeed(ThreadPersistence, persistence),
      Layer.succeed(Friday, friday),
      Layer.succeed(Crypto.Crypto, testCrypto),
      Layer.succeed(AppConfig, testAppConfig),
      Layer.succeed(
        TextGeneration,
        TextGeneration.of({
          generateThreadTitle: () =>
            Effect.fail(
              new TextGenerationError({
                operation: 'thread-title',
                detail: 'title boom detail',
                cause: new Error('underlying title\nboom'),
              }),
            ),
        }),
      ),
      Layer.succeed(
        ConversationTitles,
        ConversationTitles.of({
          generated: () => Effect.sync(() => events.push('title-generated')),
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

    yield* Effect.gen(function* () {
      const ingestion = yield* PlatformIngestion
      const platforms = yield* PlatformRegistry
      yield* platforms.register(platform)
      yield* ingestion.ingest(input, () => Effect.succeed(thread))
      yield* settleTitleSidecar
    }).pipe(
      Effect.provide(TestLive),
      Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: true })),
    )

    // Title failure stays non-fatal: no generated title, normal ingest continues.
    assert.deepStrictEqual(events, [])

    const failures = logs.filter((log) => log.message === 'conversation.title.failed')
    assert.strictEqual(failures.length, 1)
    const annotations = failures[0]?.annotations ?? {}
    assert.strictEqual(annotations.threadId, thread.id)
    assert.strictEqual(annotations.errorTag, 'TextGenerationError')
    assert.strictEqual(annotations.operation, 'thread-title')
    assert.strictEqual(annotations.detail, 'title boom detail')
    assert.strictEqual(annotations.cause, 'underlying title boom')
    assert.strictEqual(annotations.utilityProvider, 'opencode-go')
    assert.strictEqual(annotations.utilityModelId, 'deepseek-v4-flash')
    assert.strictEqual(annotations.utilityThinkingLevel, 'low')
    // Arbitrary request content never reaches failure logs.
    assert.notMatch(JSON.stringify(failures), /Hello Friday title check/u)
  }),
)
