/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, eslint/require-yield -- Follow-up tests narrow thread/turn lookups to parent/target conversations. */
import { assert, it } from '@effect/vitest'
import {
  ChannelThread,
  InputMessage,
  TurnId,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { Friday, type FridayContract } from '../Friday.ts'
import { ChannelProgress } from './ChannelProgress.ts'
import { ChannelTurns, ChannelTurnsLive } from './ChannelTurns.ts'
import { ThreadPersistence, type ThreadPersistenceContract } from './ThreadPersistence.ts'
import type { ThreadCoordinatorContract } from './ThreadCoordinator.ts'
import { harnessReloadSucceeded, isSteerRejected, SteerRejectedError } from './ThreadRuntime.ts'
import type { ThreadRuntimeError } from './ThreadRuntimes.ts'
import { ThreadRuntimeError as WrappedRuntimeError } from './ThreadRuntimes.ts'

const decodeThread = Schema.decodeSync(ChannelThread)
const decodeTurnId = Schema.decodeSync(TurnId)
const decodeMessage = Schema.decodeSync(InputMessage)

const thread = decodeThread({
  id: 'thread-followup',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/followup',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'followup', description: '' },
  conversationBinding: {
    platform: 'test',
    connectionId: 'test',
    channelId: 'channel-followup',
    sourceMessageId: 'message-followup',
    conversationId: 'conversation-followup',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const otherThread = decodeThread({ ...thread, id: 'thread-followup-other' })

const userMessage = (text: string, platformMessageId = 'message-followup') =>
  decodeMessage({ source: 'user', content: { text, images: [] }, platformMessageId })

const activeTurn = (threadId: string): TurnType => ({
  id: decodeTurnId('turn-active'),
  threadId: threadId as TurnType['threadId'],
  sequence: 1,
  input: userMessage('First'),
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
})

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
})

interface FollowupHarness {
  readonly steers: Array<string>
  readonly opens: Array<string>
  readonly started: Array<string>
  readonly accepts: Array<string>
  readonly finalizes: Array<string>
}

const runAccept = (
  harness: FollowupHarness,
  requestThread: typeof thread,
  latest: Option.Option<TurnType>,
  steerBehavior: 'succeed' | 'reject',
) =>
  Effect.scoped(
    Effect.gen(function* () {
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
        getLatestTurn: () => Effect.succeed(latest),
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
          Effect.sync(() => harness.started.push(String(turn.id))).pipe(
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
        steer: (turnId) =>
          Effect.sync(() => harness.steers.push(String(turnId))).pipe(
            Effect.andThen(
              steerBehavior === 'succeed'
                ? Effect.void
                : Effect.fail(
                    new WrappedRuntimeError({
                      operation: 'prompt',
                      cause: new SteerRejectedError({
                        turnId: String(turnId),
                        detail: 'No active Pi turn to steer.',
                      }),
                    }),
                  ),
            ),
          ),
        cancel: () => Effect.void,
        reload: () => Effect.succeed(harnessReloadSucceeded()),
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.void,
      }
      const friday: FridayContract = {
        openThread: (opened) =>
          Effect.sync(() => {
            harness.opens.push(String(opened.id))
            return coordinator
          }),
        observeRuntime: () => Effect.succeed({ runtimePresent: false, activeTurns: 0 }),
      }
      const progress = ChannelProgress.of({
        accept: (acceptedThread, _message, turnId) =>
          Effect.sync(() => harness.accepts.push(`${String(acceptedThread.id)}:${String(turnId)}`)),
        observe: () => Effect.void,
        finalize: (finalizedThread, turnId) =>
          Effect.sync(() =>
            harness.finalizes.push(`${String(finalizedThread.id)}:${String(turnId)}`),
          ),
      })
      const TestLive = Layer.mergeAll(
        Layer.succeed(ThreadPersistence, persistence),
        Layer.succeed(Friday, friday),
        Layer.succeed(Crypto.Crypto, testCrypto),
        Layer.succeed(ChannelProgress, progress),
      )
      const TurnsLive = ChannelTurnsLive.pipe(Layer.provide(TestLive))
      const FullLive = Layer.merge(TestLive, TurnsLive)
      yield* Effect.gen(function* () {
        const turns = yield* ChannelTurns
        yield* turns.accept({ thread: requestThread, message: userMessage('Follow-up') })
      }).pipe(Effect.provide(FullLive))
    }),
  )

const freshHarness = (): FollowupHarness => ({
  steers: [],
  opens: [],
  started: [],
  accepts: [],
  finalizes: [],
})

it.effect('steers the same conversation when its turn is genuinely active', () =>
  Effect.gen(function* () {
    const harness = freshHarness()
    yield* runAccept(harness, thread, Option.some(activeTurn(thread.id)), 'succeed')
    assert.deepStrictEqual(harness.steers, ['turn-active'])
    assert.deepStrictEqual(harness.opens, ['thread-followup'])
    assert.deepStrictEqual(harness.started, [])
    assert.deepStrictEqual(harness.accepts, ['thread-followup:turn-active'])
    assert.deepStrictEqual(harness.finalizes, [])
  }),
)

it.effect('falls back exactly once to a new turn when steering is rejected', () =>
  Effect.gen(function* () {
    const harness = freshHarness()
    yield* runAccept(harness, thread, Option.some(activeTurn(thread.id)), 'reject')
    assert.deepStrictEqual(harness.steers, ['turn-active'])
    assert.lengthOf(harness.started, 1)
    assert.lengthOf(harness.accepts, 1)
    assert.isFalse(harness.accepts[0]?.endsWith(':turn-active'))
    assert.lengthOf(harness.finalizes, 1)
  }),
)

it.effect('matches direct and wrapped rejections without matching other errors', () =>
  Effect.gen(function* () {
    const direct = new SteerRejectedError({ turnId: 'turn-active', detail: 'No active Pi turn.' })
    const wrapped = new WrappedRuntimeError({ operation: 'prompt', cause: direct })
    assert.strictEqual(isSteerRejected(direct), true)
    assert.strictEqual(isSteerRejected(wrapped), true)
    assert.strictEqual(isSteerRejected(new Error('boom')), false)
  }),
)

it.effect('starts an independent turn for a different conversation', () =>
  Effect.gen(function* () {
    const harness = freshHarness()
    yield* runAccept(harness, otherThread, Option.none(), 'succeed')
    assert.deepStrictEqual(harness.steers, [])
    assert.lengthOf(harness.started, 1)
    assert.lengthOf(harness.accepts, 1)
    assert.isTrue(harness.accepts[0]?.startsWith('thread-followup-other:'))
  }),
)
