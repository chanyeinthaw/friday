/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, eslint/require-yield -- Follow-up tests narrow thread/turn lookups to parent/target conversations. */
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
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
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
import { rebindToSlackThread } from './slack/SlackThreadRouting.ts'
import type { PlatformAdapter, PlatformInput } from './PlatformAdapter.ts'
import { PlatformRegistry, PlatformRegistryLive } from './PlatformRegistry.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeMessage = Schema.decodeSync(InputMessage)
const decodeThread = Schema.decodeSync(ChannelThread)
const decodeTurnId = Schema.decodeSync(TurnId)
const decodeModel = Schema.decodeSync(ModelSelection)

const testModel = decodeModel({ provider: 'opencode-go', modelId: 'deepseek-v4-flash' })
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

const parentBinding = decodeBinding({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild:channel',
  sourceMessageId: 'message-parent',
  conversationId: 'discord:guild:channel:channel',
})
const targetBinding = decodeBinding({
  ...parentBinding,
  conversationId: 'discord:guild:channel:thread',
})

const parentThread = decodeThread({
  id: 'thread-parent',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/parent',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'parent', description: '' },
  conversationBinding: parentBinding,
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})
const targetThread = decodeThread({
  ...parentThread,
  id: 'thread-target',
  workingDirectory: '/tmp/target',
  conversationBinding: targetBinding,
})

const messageFor = (text: string, platformMessageId: string) =>
  decodeMessage({ source: 'user', content: { text, images: [] }, platformMessageId })

const inputFor = (binding: typeof parentBinding, text: string, platformMessageId: string) => ({
  binding,
  message: messageFor(text, platformMessageId),
})

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
})

it.effect('starts an independently routed new turn for a parent message after routing', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const steers: Array<string> = []
      const prompts: Array<string> = []
      const opened: Array<string> = []
      const activeTargetTurn: TurnType = {
        id: decodeTurnId('turn-target-active'),
        threadId: targetThread.id,
        sequence: 1,
        input: messageFor('Routed A', 'message-a'),
        agentMessage: null,
        activities: [],
        model: targetThread.model,
        thinkingLevel: targetThread.thinkingLevel,
        harnessTurnId: null,
        status: 'running',
        requestedAt: '2026-03-21T10:00:00.000Z',
        startedAt: '2026-03-21T10:00:00.000Z',
        completedAt: null,
        errorMessage: null,
        usage: null,
      }
      const persistence: ThreadPersistenceContract = {
        createThread: () => Effect.void,
        getThread: () => Effect.succeedNone,
        findPlatformThread: (lookup) =>
          Effect.succeed(
            String(lookup.conversationId) === String(targetBinding.conversationId)
              ? Option.some(targetThread as ThreadType)
              : String(lookup.conversationId) === String(parentBinding.conversationId)
                ? Option.some(parentThread as ThreadType)
                : Option.none(),
          ),
        listAgentThreads: () => Effect.succeed([]),
        closeThread: () => Effect.void,
        setThreadHarnessSession: () => Effect.void,
        setThreadModel: () => Effect.void,
        createTurn: () => Effect.void,
        getTurn: () => Effect.succeedNone,
        getFirstTurn: () => Effect.succeedNone,
        getLatestTurn: (threadId) =>
          Effect.succeed(
            String(threadId) === targetThread.id ? Option.some(activeTargetTurn) : Option.none(),
          ),
        listTurns: () => Effect.succeed([]),
        getLatestUserTurn: () => Effect.succeedNone,
        startTurn: () => Effect.void,
        putActivitySnapshot: () => Effect.void,
        getActivity: () => Effect.succeedNone,
        completeTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        failTurn: () => Effect.void,
      }
      const coordinatorFor = (
        threadId: string,
      ): ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError> => ({
        prompt: (turn) =>
          Effect.sync(() => prompts.push(`${threadId}:${String(turn.id)}`)).pipe(
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
        steer: (turnId) => Effect.sync(() => steers.push(`${threadId}:${String(turnId)}`)),
        cancel: () => Effect.void,
        reload: () => Effect.succeed(harnessReloadSucceeded()),
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.void,
      })
      const friday: FridayContract = {
        openThread: (thread) =>
          Effect.sync(() => {
            opened.push(String(thread.id))
            return coordinatorFor(String(thread.id))
          }),
        observeRuntime: () => Effect.succeed({ runtimePresent: false, activeTurns: 0 }),
      }
      const platform: PlatformAdapter<never> = {
        connectionId: parentBinding.connectionId,
        kind: 'discord',
        publish: () => Effect.void,
        acknowledge: () => Effect.void,
        beginWorking: () => Effect.void,
        updateWorking: () => Effect.void,
        setAgentActivity: () => Effect.void,
        searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
        setConversationTitle: () => Effect.void,
        discardWorking: () => Effect.void,
        finalizeWorking: () => Effect.void,
        withTyping: (_binding, effect) => effect,
      }
      const dependencies = Layer.mergeAll(
        Layer.succeed(ThreadPersistence, persistence),
        Layer.succeed(Friday, friday),
        Layer.succeed(Crypto.Crypto, testCrypto),
        Layer.succeed(
          AppConfig,
          AppConfig.of({
            current: () => testConfig,
            reload: Effect.die('reload not expected'),
          }),
        ),
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
          inputFor(parentBinding, 'Parent B', 'message-b') as PlatformInput,
          () => Effect.succeed(parentThread as ThreadType),
          (current) => Effect.succeed(current),
          (enriched) => Effect.succeed(enriched),
        )
      }).pipe(Effect.provide(TestLive))

      assert.deepStrictEqual(opened, ['thread-parent'])
      assert.deepStrictEqual(steers, [])
      assert.lengthOf(
        prompts.filter((entry) => entry.startsWith('thread-parent:')),
        1,
      )
    }),
  ),
)

it.effect('releases the binding semaphore before terminal waiting so follow-ups steer', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts: Array<string> = []
      const steers: Array<string> = []
      const release = yield* Deferred.make<void>()
      const promptStarted = yield* Deferred.make<void>()
      const steerObserved = yield* Deferred.make<void>()
      const persistence: ThreadPersistenceContract = {
        createThread: () => Effect.void,
        getThread: () => Effect.succeedNone,
        findPlatformThread: () => Effect.succeedSome(parentThread as ThreadType),
        listAgentThreads: () => Effect.succeed([]),
        closeThread: () => Effect.void,
        setThreadHarnessSession: () => Effect.void,
        setThreadModel: () => Effect.void,
        createTurn: () => Effect.void,
        getTurn: () => Effect.succeedNone,
        getFirstTurn: () => Effect.succeedNone,
        getLatestTurn: (threadId) =>
          Effect.succeed(
            prompts.length > 0
              ? Option.some({
                  id: decodeTurnId('turn-first'),
                  threadId: threadId as TurnType['threadId'],
                  sequence: 1,
                  input: messageFor('First', 'message-1'),
                  agentMessage: null,
                  activities: [],
                  model: parentThread.model,
                  thinkingLevel: parentThread.thinkingLevel,
                  harnessTurnId: null,
                  status: 'running',
                  requestedAt: '2026-03-21T10:00:00.000Z',
                  startedAt: '2026-03-21T10:00:00.000Z',
                  completedAt: null,
                  errorMessage: null,
                  usage: null,
                })
              : Option.none(),
          ),
        listTurns: () => Effect.succeed([]),
        getLatestUserTurn: () => Effect.succeedNone,
        startTurn: () => Effect.void,
        putActivitySnapshot: () => Effect.void,
        getActivity: () => Effect.succeedNone,
        completeTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        failTurn: () => Effect.void,
      }
      const coordinator: ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError> = {
        prompt: (turn) =>
          Effect.sync(() => prompts.push(String(turn.id))).pipe(
            Effect.andThen(Deferred.succeed(promptStarted, undefined)),
            Effect.as({
              turnId: turn.id,
              awaitTerminal: Deferred.await(release).pipe(
                Effect.as({
                  status: 'completed' as const,
                  turnId: turn.id,
                  agentMessage: 'first done',
                  usage: null,
                }),
              ),
            }),
          ),
        steer: (turnId) =>
          Effect.sync(() => steers.push(String(turnId))).pipe(
            Effect.andThen(Deferred.succeed(steerObserved, undefined)),
          ),
        cancel: () => Effect.void,
        reload: () => Effect.succeed(harnessReloadSucceeded()),
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.void,
      }
      const friday: FridayContract = {
        openThread: () => Effect.succeed(coordinator),
        observeRuntime: () => Effect.succeed({ runtimePresent: false, activeTurns: 0 }),
      }
      const platform: PlatformAdapter<never> = {
        connectionId: parentBinding.connectionId,
        kind: 'discord',
        publish: () => Effect.void,
        acknowledge: () => Effect.void,
        beginWorking: () => Effect.void,
        updateWorking: () => Effect.void,
        setAgentActivity: () => Effect.void,
        searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
        setConversationTitle: () => Effect.void,
        discardWorking: () => Effect.void,
        finalizeWorking: () => Effect.void,
        withTyping: (_binding, effect) => effect,
      }
      const dependencies = Layer.mergeAll(
        Layer.succeed(ThreadPersistence, persistence),
        Layer.succeed(Friday, friday),
        Layer.succeed(Crypto.Crypto, testCrypto),
        Layer.succeed(
          AppConfig,
          AppConfig.of({
            current: () => testConfig,
            reload: Effect.die('reload not expected'),
          }),
        ),
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
      const TurnsLive = ChannelTurnsLive.pipe(
        Layer.provide(Layer.merge(dependencies, ProgressLive)),
      )
      const TestLive = Layer.merge(
        Layer.mergeAll(dependencies, ProgressLive, TurnsLive),
        PlatformIngestionLive.pipe(Layer.provide(Layer.merge(dependencies, TurnsLive))),
      )
      const runIngest = (text: string, platformMessageId: string) =>
        Effect.gen(function* () {
          const ingestion = yield* PlatformIngestion
          const platforms = yield* PlatformRegistry
          yield* platforms.register(platform)
          yield* ingestion.ingest(
            inputFor(parentBinding, text, platformMessageId) as PlatformInput,
            () => Effect.succeed(parentThread as ThreadType),
          )
        }).pipe(Effect.provide(TestLive), Effect.scoped)

      const first = yield* runIngest('First', 'message-1').pipe(Effect.forkScoped)
      yield* Deferred.await(promptStarted)
      const second = yield* runIngest('Second', 'message-2').pipe(Effect.forkScoped)
      yield* Deferred.await(steerObserved)
      assert.deepStrictEqual(steers.length, 1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
    }),
  ),
)

it.effect('keeps Slack reply-in-thread routing independent via common dispatch', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const slackParent = decodeBinding({
        platform: 'slack',
        connectionId: 'slack-test',
        channelId: 'slack:T1:C1',
        sourceMessageId: '1710000000.000100',
        conversationId: 'slack:T1:C1',
      })
      const parentInput = {
        binding: slackParent,
        message: messageFor('Slack parent', '1710000000.000100'),
      } as PlatformInput
      const rebound = rebindToSlackThread(parentInput, '1710000000.000100')
      assert.strictEqual(String(rebound.binding.conversationId), 'slack:T1:C1:1710000000.000100')
      assert.strictEqual(rebound.binding.channelId, slackParent.channelId)
      assert.strictEqual(rebound.message.content.text, 'Slack parent')
    }),
  ),
)
