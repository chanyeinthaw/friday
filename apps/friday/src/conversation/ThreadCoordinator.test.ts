import { assert, it } from '@effect/vitest'
import {
  Activity,
  HarnessSession,
  type Activity as ActivityType,
  Turn,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { makeThreadCoordinator } from './ThreadCoordinator.ts'
import { ThreadPersistence, type ThreadPersistenceContract } from './ThreadPersistence.ts'
import { harnessReloadSucceeded, type ThreadRuntimeEvent } from './ThreadRuntime.ts'

const decodeActivity = Schema.decodeUnknownSync(Activity)
const decodeTurn = Schema.decodeUnknownSync(Turn)
const harnessSession = Schema.decodeSync(HarnessSession)({
  id: 'session-1',
  resumeCursor: null,
})
const steeringActivity = decodeActivity({
  id: 'activity-steering',
  sequence: 0,
  status: 'completed',
  type: 'steering',
  message: {
    source: 'user',
    content: { text: 'Also inspect the tests', images: [] },
  },
  createdAt: '2026-03-21T10:00:01.000Z',
  updatedAt: '2026-03-21T10:00:01.000Z',
  completedAt: '2026-03-21T10:00:01.000Z',
})

const requestedAt = '2026-03-21T10:00:00.000Z'
const startedAt = '2026-03-21T10:00:01.000Z'
const updatedAt = '2026-03-21T10:00:02.000Z'
const completedAt = '2026-03-21T10:00:03.000Z'

const turn = decodeTurn({
  id: 'turn-1',
  threadId: 'thread-1',
  sequence: 1,
  input: {
    source: 'user',
    content: { text: 'Inspect the repository', images: [] },
  },
  agentMessage: null,
  activities: [],
  model: { provider: 'anthropic', modelId: 'claude-sonnet' },
  thinkingLevel: 'medium',
  harnessTurnId: null,
  status: 'pending',
  requestedAt,
  startedAt: null,
  completedAt: null,
  errorMessage: null,
  usage: null,
})

const activeActivity = decodeActivity({
  id: 'activity-1',
  sequence: 0,
  status: 'active',
  type: 'tool-result',
  callId: 'call-1',
  output: 'half complete',
  isError: false,
  createdAt: startedAt,
  updatedAt,
  completedAt: null,
})

const completedActivity = decodeActivity({
  ...activeActivity,
  status: 'completed',
  output: 'complete',
  updatedAt: completedAt,
  completedAt,
})

const runtimeEvents: ReadonlyArray<ThreadRuntimeEvent> = [
  {
    type: 'turn-started',
    turnId: turn.id,
    harnessTurnId: null,
    startedAt,
  },
  {
    type: 'activity-started',
    turnId: turn.id,
    activity: activeActivity,
  },
  {
    type: 'activity-updated',
    turnId: turn.id,
    activity: activeActivity,
  },
  {
    type: 'activity-completed',
    turnId: turn.id,
    activity: completedActivity,
  },
  {
    type: 'turn-completed',
    turnId: turn.id,
    agentMessage: 'Done.',
    usage: null,
    completedAt,
  },
]

interface RecordedOperation {
  readonly type: string
  readonly value: ActivityType | TurnType | string
}

it.effect('persists a Turn before prompting its runtime', () =>
  Effect.gen(function* () {
    const operations: Array<RecordedOperation> = []
    const runtime = {
      threadId: turn.threadId,
      harnessSession,
      prompt: ({ turnId }: { readonly turnId: typeof turn.id }) =>
        Effect.sync(() => operations.push({ type: 'prompt', value: turnId })),
      cancel: () => Effect.void,
      reload: () => Effect.succeed(harnessReloadSucceeded()),
      events: Stream.empty,
    }
    const coordinator = yield* makeThreadCoordinator(runtime).pipe(
      Effect.provideService(ThreadPersistence, makePersistence(operations)),
    )

    yield* coordinator.prompt(turn)

    assert.deepStrictEqual(
      operations.map(({ type }) => type),
      ['create-turn', 'prompt'],
    )
  }),
)

it.effect('completes the Turn handle after a prompt delivery failure is persisted', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const operations: Array<RecordedOperation> = []
      const runtime = {
        threadId: turn.threadId,
        harnessSession,
        prompt: () => Effect.fail('prompt-boom'),
        cancel: () => Effect.void,
        reload: () => Effect.succeed(harnessReloadSucceeded()),
        events: Stream.never,
      }
      const coordinator = yield* makeThreadCoordinator(runtime).pipe(
        Effect.provideService(ThreadPersistence, makePersistence(operations)),
      )

      const handle = yield* coordinator.prompt(turn)
      const terminal = yield* handle.awaitTerminal

      assert.strictEqual(terminal.status, 'failed')
      assert.deepStrictEqual(
        operations.map(({ type }) => type),
        ['create-turn', 'fail-turn'],
      )
    }),
  ),
)

it.effect('persists steering before delivering it to the runtime', () =>
  Effect.gen(function* () {
    const operations: Array<RecordedOperation> = []
    if (steeringActivity.type !== 'steering') return
    let deliveredAuthorization: 'allowed' | 'denied' | undefined
    const runtime = {
      threadId: turn.threadId,
      harnessSession,
      prompt: (request: {
        readonly turnId: typeof turn.id
        readonly authorization?: { readonly externalUpdateRequests: 'allowed' | 'denied' }
      }) =>
        Effect.sync(() => {
          deliveredAuthorization = request.authorization?.externalUpdateRequests
          operations.push({ type: 'prompt', value: request.turnId })
        }),
      cancel: () => Effect.void,
      reload: () => Effect.succeed(harnessReloadSucceeded()),
      events: Stream.empty,
    }
    const coordinator = yield* makeThreadCoordinator(runtime).pipe(
      Effect.provideService(ThreadPersistence, makePersistence(operations)),
    )

    yield* coordinator.steer(turn.id, steeringActivity, {
      externalUpdateRequests: 'denied',
    })

    assert.deepStrictEqual(
      operations.map(({ type }) => type),
      ['put-activity', 'prompt'],
    )
    assert.strictEqual(deliveredAuthorization, 'denied')
  }),
)

it.effect('signals completion only after the terminal event is persisted', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const operations: Array<RecordedOperation> = []
      const events = yield* Deferred.make<ReadonlyArray<ThreadRuntimeEvent>>()
      const runtime = {
        threadId: turn.threadId,
        harnessSession,
        prompt: () => Effect.void,
        cancel: () => Effect.void,
        reload: () => Effect.succeed(harnessReloadSucceeded()),
        events: Stream.unwrap(
          Deferred.await(events).pipe(Effect.map((items) => Stream.fromIterable(items))),
        ),
      }
      const coordinator = yield* makeThreadCoordinator(runtime).pipe(
        Effect.provideService(ThreadPersistence, makePersistence(operations)),
      )
      yield* coordinator.start
      const handle = yield* coordinator.prompt(turn)
      const waiter = yield* handle.awaitTerminal.pipe(Effect.forkChild)

      yield* Effect.yieldNow
      assert.strictEqual(waiter.pollUnsafe(), undefined)

      yield* Deferred.succeed(events, runtimeEvents)
      const terminal = yield* Fiber.join(waiter)

      assert.strictEqual(terminal.status, 'completed')
      assert.deepStrictEqual(
        operations.map(({ type }) => type),
        [
          'create-turn',
          'start-turn',
          'put-activity',
          'put-activity',
          'put-activity',
          'complete-turn',
        ],
      )
    }),
  ),
)

it.effect('persists active snapshots and the completed Activity in event order', () =>
  Effect.gen(function* () {
    const operations: Array<RecordedOperation> = []
    const runtime = {
      threadId: turn.threadId,
      harnessSession,
      prompt: () => Effect.void,
      cancel: () => Effect.void,
      reload: () => Effect.succeed(harnessReloadSucceeded()),
      events: Stream.fromIterable(runtimeEvents),
    }
    const coordinator = yield* makeThreadCoordinator(runtime).pipe(
      Effect.provideService(ThreadPersistence, makePersistence(operations)),
    )

    yield* coordinator.drain

    assert.deepStrictEqual(
      operations.map(({ type }) => type),
      ['start-turn', 'put-activity', 'put-activity', 'put-activity', 'complete-turn'],
    )
    assert.strictEqual(operations.at(1)?.value, activeActivity)
    assert.strictEqual(operations.at(3)?.value, completedActivity)
  }),
)

const makePersistence = (operations: Array<RecordedOperation>): ThreadPersistenceContract => ({
  createThread: () => Effect.void,
  getThread: () => Effect.succeedNone,
  findPlatformThread: () => Effect.succeedNone,
  listAgentThreads: () => Effect.succeed([]),
  closeThread: () => Effect.void,
  setThreadHarnessSession: () => Effect.void,
  createTurn: (value) => Effect.sync(() => operations.push({ type: 'create-turn', value })),
  getTurn: () => Effect.succeedNone,
  getFirstTurn: () => Effect.succeedNone,
  getLatestTurn: () => Effect.succeedNone,
  getLatestUserTurn: () => Effect.succeedNone,
  startTurn: ({ turnId }) =>
    Effect.sync(() => operations.push({ type: 'start-turn', value: turnId })),
  putActivitySnapshot: (_turnId, value) =>
    Effect.sync(() => operations.push({ type: 'put-activity', value })),
  getActivity: () => Effect.succeedNone,
  completeTurn: ({ turnId }) =>
    Effect.sync(() => operations.push({ type: 'complete-turn', value: turnId })),
  interruptTurn: ({ turnId }) =>
    Effect.sync(() => operations.push({ type: 'interrupt-turn', value: turnId })),
  failTurn: ({ turnId }) =>
    Effect.sync(() => operations.push({ type: 'fail-turn', value: turnId })),
})
