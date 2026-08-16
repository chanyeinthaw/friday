import { assert, it } from '@effect/vitest'
import { ChannelThread, HarnessSession, Turn } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { makeFridayApplication } from './FridayApplication.ts'
import {
  ThreadPersistence,
  type ThreadPersistenceContract,
} from './conversation/ThreadPersistence.ts'

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-application',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-application',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  externalBinding: {
    platform: 'discord',
    channelId: 'channel-application',
    sourceMessageId: 'message-application',
    externalThreadId: 'external-thread-application',
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

const harnessSession = Schema.decodeSync(HarnessSession)({
  id: 'pi-session-application',
  resumeCursor: { sessionId: 'pi-session-application' },
})

it.effect('opens a Thread and returns its started persistence-first coordinator', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const operations: Array<string> = []
      const persistence = makePersistence(operations)
      const application = yield* makeFridayApplication((openedThread) =>
        Effect.sync(() => {
          operations.push(`runtime:${openedThread.id}`)
          return {
            threadId: openedThread.id,
            harnessSession,
            prompt: () => Effect.sync(() => operations.push('prompt')),
            events: Stream.empty,
          }
        }),
      ).pipe(Effect.provideService(ThreadPersistence, persistence))

      const coordinator = yield* application.openThread(thread)
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
  findChannelThread: () => Effect.succeedNone,
  setThreadHarnessSession: () =>
    Effect.sync(() => {
      operations.push('set-harness-session')
    }),
  createTurn: () =>
    Effect.sync(() => {
      operations.push('create-turn')
    }),
  getTurn: () => Effect.succeedNone,
  getLatestTurn: () => Effect.succeedNone,
  startTurn: () => Effect.void,
  putActivitySnapshot: () => Effect.void,
  getActivity: () => Effect.succeedNone,
  completeTurn: () => Effect.void,
  interruptTurn: () => Effect.void,
  failTurn: () => Effect.void,
})
