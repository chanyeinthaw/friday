import { assert, it } from '@effect/vitest'
import { ChannelThread, Turn } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { Friday, FridayLive } from './Friday.ts'
import { ThreadRuntimePool } from './conversation/ThreadRuntimePool.ts'
import { harnessReloadSucceeded } from './conversation/ThreadRuntime.ts'
import type { ThreadPersistenceContract } from './conversation/ThreadPersistence.ts'

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-application',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-application',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'Friday test channel', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'channel-application',
    sourceMessageId: 'message-application',
    conversationId: 'platform-conversation-application',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const turn = Schema.decodeSync(Turn)({
  id: 'turn-application',
  threadId: thread.id,
  sequence: 1,
  input: {
    source: 'user',
    content: { text: 'Start Friday', images: [] },
  },
  agentMessage: null,
  activities: [],
  model: thread.model,
  thinkingLevel: thread.thinkingLevel,
  harnessTurnId: null,
  status: 'pending',
  requestedAt: '2026-03-21T10:00:00.000Z',
  startedAt: null,
  completedAt: null,
  errorMessage: null,
  usage: null,
})

it.effect('opens a Thread through the runtime service and returns its started coordinator', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const operations: Array<string> = []
      const persistence = makePersistence(operations)
      const pooledCoordinator = {
        prompt: (promptedTurn: typeof turn) =>
          persistence.createTurn(promptedTurn).pipe(
            Effect.andThen(Effect.sync(() => operations.push('prompt'))),
            Effect.as({
              turnId: promptedTurn.id,
              awaitTerminal: Effect.never,
            }),
          ),
        steer: () => Effect.void,
        cancel: () => Effect.void,
        reload: () => Effect.succeed(harnessReloadSucceeded()),
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.void,
      }
      const friday = yield* Friday.pipe(
        Effect.provide(
          FridayLive.pipe(
            Layer.provide(
              Layer.succeed(ThreadRuntimePool, {
                acquire: (openedThread) =>
                  Effect.sync(() => {
                    operations.push(`runtime:${openedThread.id}`)
                    operations.push('set-harness-session')
                    return pooledCoordinator
                  }),
                reloadHarness: () => Effect.succeed(harnessReloadSucceeded()),
                reapIdle: Effect.void,
              }),
            ),
          ),
        ),
      )

      const coordinator = yield* friday.openThread(thread)
      yield* coordinator.prompt(turn)

      assert.deepStrictEqual(operations, [
        `runtime:${thread.id}`,
        'set-harness-session',
        'create-turn',
        'prompt',
      ])
    }),
  ),
)

const makePersistence = (operations: Array<string>): ThreadPersistenceContract => ({
  createThread: () => Effect.void,
  getThread: () => Effect.succeedNone,
  findPlatformThread: () => Effect.succeedNone,
  listAgentThreads: () => Effect.succeed([]),
  closeThread: () => Effect.void,
  setThreadHarnessSession: () =>
    Effect.sync(() => {
      operations.push('set-harness-session')
    }),
  createTurn: () =>
    Effect.sync(() => {
      operations.push('create-turn')
    }),
  getTurn: () => Effect.succeedNone,
  getFirstTurn: () => Effect.succeedNone,
  getLatestTurn: () => Effect.succeedNone,
  startTurn: () => Effect.void,
  putActivitySnapshot: () => Effect.void,
  getActivity: () => Effect.succeedNone,
  completeTurn: () => Effect.void,
  interruptTurn: () => Effect.void,
  failTurn: () => Effect.void,
})
