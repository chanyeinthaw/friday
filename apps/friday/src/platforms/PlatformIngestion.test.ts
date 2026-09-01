import { assert, it } from '@effect/vitest'
import {
  ChannelThread,
  ConversationBinding,
  InputMessage,
  ModelSelection,
  TurnId,
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
import type { PlatformAdapter } from './PlatformAdapter.ts'
import { PlatformRegistry, PlatformRegistryLive } from './PlatformRegistry.ts'

const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'discord:channel-1:message-1',
})
const input = {
  binding,
  message: Schema.decodeSync(InputMessage)({
    source: 'user',
    content: { text: 'Hello Friday', images: [] },
    platformMessageId: 'message-1',
  }),
}
const thread: ThreadType = Schema.decodeSync(ChannelThread)({
  id: 'thread-ingestion',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-ingestion',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'Friday test channel', description: '' },
  conversationBinding: binding,
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})
const decodeTurnId = Schema.decodeSync(TurnId)

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
  reload: Effect.die('reload is not expected in PlatformIngestion tests'),
})

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
})

it.effect('routes a new Turn through Friday and publishes its final response', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const persistence = makePersistence(events)
      const friday = makeFriday(events, persistence)
      const platform = makePlatform(events)
      const dependencies = Layer.mergeAll(
        Layer.succeed(ThreadPersistence, persistence),
        Layer.succeed(Friday, friday),
        Layer.succeed(Crypto.Crypto, testCrypto),
        Layer.succeed(AppConfig, testAppConfig),
        Layer.succeed(
          TextGeneration,
          TextGeneration.of({ generateThreadTitle: () => Effect.succeed('Test Thread') }),
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
        yield* ingestion.ingest(input, () => Effect.succeed(thread))
      }).pipe(Effect.provide(TestLive))

      assert.deepStrictEqual(events, [
        'acknowledge',
        'working:-# Thinking...',
        'open-thread',
        'prompt',
        'finalize:Friday is done.',
      ])
    }),
  ),
)

it.effect('loads initial platform context only when creating a new channel Thread', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const persistence = makePersistence(events, { newThread: true })
      const friday = makeFriday(events, persistence)
      const platform = makePlatform(events)
      const dependencies = Layer.mergeAll(
        Layer.succeed(ThreadPersistence, persistence),
        Layer.succeed(Friday, friday),
        Layer.succeed(Crypto.Crypto, testCrypto),
        Layer.succeed(AppConfig, testAppConfig),
        Layer.succeed(
          TextGeneration,
          TextGeneration.of({ generateThreadTitle: () => Effect.succeed('Test Thread') }),
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
          input,
          () => Effect.succeed(thread),
          (initial) =>
            Effect.sync(() => {
              events.push('load-initial-context')
              return { ...initial, initialContext: [] }
            }),
        )
      }).pipe(Effect.provide(TestLive))

      assert.strictEqual(events.filter((event) => event === 'load-initial-context').length, 1)
    }),
  ),
)

it.effect('routes follow-up input to steering without another typing lifecycle', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const persistence = makePersistence(events, { latestIsActive: true })
      const friday = makeFriday(events, persistence)
      const platform = makePlatform(events)
      const dependencies = Layer.mergeAll(
        Layer.succeed(ThreadPersistence, persistence),
        Layer.succeed(Friday, friday),
        Layer.succeed(Crypto.Crypto, testCrypto),
        Layer.succeed(AppConfig, testAppConfig),
        Layer.succeed(
          TextGeneration,
          TextGeneration.of({ generateThreadTitle: () => Effect.succeed('Test Thread') }),
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
        yield* ingestion.ingest(input, () => Effect.succeed(thread))
      }).pipe(Effect.provide(TestLive))

      assert.deepStrictEqual(events, [
        'acknowledge',
        'working:-# Thinking...',
        'open-thread',
        'steer',
      ])
    }),
  ),
)

const makePlatform = (events: Array<string>): PlatformAdapter<never> => ({
  connectionId: binding.connectionId,
  kind: 'discord',
  publish: ({ text }) => Effect.sync(() => events.push(`publish:${text}`)),
  acknowledge: () => Effect.sync(() => events.push('acknowledge')),
  beginWorking: ({ text }) => Effect.sync(() => events.push(`working:${text}`)),
  updateWorking: ({ text }) => Effect.sync(() => events.push(`update:${text}`)),
  setAgentActivity: () => Effect.void,
  searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
  setConversationTitle: () => Effect.void,
  discardWorking: () => Effect.void,
  finalizeWorking: ({ text }) => Effect.sync(() => events.push(`finalize:${text}`)),
  withTyping: (_binding, effect) =>
    Effect.sync(() => events.push('typing-started')).pipe(
      Effect.andThen(effect),
      Effect.ensuring(Effect.sync(() => events.push('typing-stopped'))),
    ),
})

const makeFriday = (
  events: Array<string>,
  persistence: ThreadPersistenceContract,
): FridayContract => ({
  openThread: () =>
    Effect.sync(() => {
      events.push('open-thread')
      return {
        prompt: (turn) =>
          persistence.createTurn(turn).pipe(
            Effect.andThen(
              Effect.sync(() => {
                events.push('prompt')
              }),
            ),
            Effect.as({
              turnId: turn.id,
              awaitTerminal: Effect.succeed({
                status: 'completed' as const,
                turnId: turn.id,
                agentMessage: 'Friday is done.',
                usage: null,
              }),
            }),
          ),
        steer: () => Effect.sync(() => events.push('steer')),
        cancel: () => Effect.void,
        reload: () => Effect.succeed(harnessReloadSucceeded()),
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.void,
      } satisfies ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>
    }),
})

const makePersistence = (
  _events: Array<string>,
  options: { readonly latestIsActive?: boolean; readonly newThread?: boolean } = {},
): ThreadPersistenceContract => {
  let storedTurn: TurnType | null = null
  const activeTurn: TurnType = {
    id: decodeTurnId('active-turn'),
    threadId: thread.id,
    sequence: 1,
    input: input.message,
    agentMessage: null,
    activities: [],
    model: thread.model,
    thinkingLevel: thread.thinkingLevel,
    harnessTurnId: null,
    status: 'running',
    requestedAt: '2026-03-21T10:00:00.000Z',
    startedAt: '2026-03-21T10:00:00.000Z',
    completedAt: null,
    errorMessage: null,
    usage: null,
  }
  return {
    createThread: () => Effect.void,
    getThread: () => Effect.succeedNone,
    findPlatformThread: () => (options.newThread ? Effect.succeedNone : Effect.succeedSome(thread)),
    listAgentThreads: () => Effect.succeed([]),
    closeThread: () => Effect.void,
    setThreadHarnessSession: () => Effect.void,
    createTurn: (turn) => Effect.sync(() => void (storedTurn = turn)),
    getTurn: () =>
      Effect.sync(() =>
        storedTurn === null
          ? Option.none()
          : Option.some({
              ...storedTurn,
              status: 'completed',
              agentMessage: 'Friday is done.',
            }),
      ),
    getFirstTurn: () => Effect.succeedNone,
    getLatestTurn: () =>
      Effect.succeed(
        options.latestIsActive
          ? Option.some(activeTurn)
          : storedTurn === null
            ? Option.none()
            : Option.some(storedTurn),
      ),
    startTurn: () => Effect.void,
    putActivitySnapshot: () => Effect.void,
    getActivity: () => Effect.succeedNone,
    completeTurn: () => Effect.void,
    interruptTurn: () => Effect.void,
    failTurn: () => Effect.void,
  }
}
