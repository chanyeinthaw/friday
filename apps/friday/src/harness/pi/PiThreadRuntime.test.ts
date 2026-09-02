/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/run-effect-inside-effect, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- The controllable Pi session implements the SDK's Promise callback boundary; Effect exits use _tag; the test entry point provides Bun Crypto. */

import { assert, it } from '@effect/vitest'
import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import {
  ActivityId,
  ChannelThread,
  HarnessSession,
  MessageAuthor,
  TurnId,
} from '@friday/contracts/conversation'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  makePiThreadRuntime,
  projectPiSessionEvent,
  type PiAgentSessionContract,
  type PiProjectionState,
} from './PiThreadRuntime.ts'
import { PromptMessageEnvelopeJson } from './PromptMessage.ts'
import type { ThreadRuntimeEvent } from '../../conversation/ThreadRuntime.ts'

const decodeActivityId = Schema.decodeSync(ActivityId)
const decodeTurnId = Schema.decodeSync(TurnId)
const decodeThread = Schema.decodeSync(ChannelThread)
const decodeHarnessSession = Schema.decodeSync(HarnessSession)
const decodeAuthor = Schema.decodeSync(MessageAuthor)
const decodePromptMessageEnvelope = Schema.decodeSync(PromptMessageEnvelopeJson)

const piEvent = (event: AgentSessionEvent): AgentSessionEvent => event

it.effect('runs the complete Pi wrapper lifecycle through ThreadRuntime', () =>
  Effect.gen(function* () {
    const prompts: Array<{
      readonly text: string
      readonly behavior: 'steer' | 'followUp' | undefined
    }> = []
    let listener: ((event: AgentSessionEvent) => void | Promise<void>) | undefined
    let unsubscribed = false
    let abortCount = 0
    let disposeCount = 0
    const session = {
      sessionId: 'pi-session-lifecycle',
      sessionManager: { getSessionFile: () => '/tmp/pi-session-lifecycle.jsonl' },
      subscribe: (next) => {
        listener = next
        return () => {
          unsubscribed = true
          listener = undefined
        }
      },
      bindExtensions: async () => undefined,
      prompt: async (text, options) => {
        prompts.push({ text, behavior: options?.streamingBehavior })
        if (options?.streamingBehavior === 'steer') return
        await listener?.({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'FRIDAY_FAKE_OK' }],
            api: 'anthropic-messages',
            provider: 'opencode-go',
            model: 'deepseek-v4-flash',
            usage: {
              input: 12,
              output: 4,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 16,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            timestamp: 0,
          },
        })
      },
      abort: async () => {
        abortCount++
      },
      reload: async () => undefined,
      dispose: () => {
        disposeCount++
      },
      getSessionStats: () => ({
        sessionFile: '/tmp/pi-session-lifecycle.jsonl',
        sessionId: 'pi-session-lifecycle',
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, total: 16 },
        cost: 0,
      }),
    } satisfies PiAgentSessionContract
    const scope = yield* Scope.make()
    const runtime = yield* makePiThreadRuntime({
      thread: decodeThread({
        id: 'thread-lifecycle',
        audience: 'user',
        parent: null,
        harness: 'pi',
        harnessSession: null,
        workingDirectory: '/tmp/friday/thread-lifecycle',
        model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
        thinkingLevel: 'max',
        channelContext: { name: 'Friday test channel', description: '' },
        conversationBinding: {
          platform: 'discord',
          connectionId: 'discord',
          channelId: 'channel-lifecycle',
          sourceMessageId: 'message-lifecycle',
          conversationId: 'platform-conversation-lifecycle',
        },
        status: 'active',
        createdAt: '2026-03-21T09:00:00.000Z',
        updatedAt: '2026-03-21T09:00:00.000Z',
        closedAt: null,
      }),
      sessionFactory: () => Effect.succeed(session),
    }).pipe(Effect.provideService(Scope.Scope, scope))
    assert.deepStrictEqual(
      runtime.harnessSession,
      decodeHarnessSession({
        id: 'pi-session-lifecycle',
        resumeCursor: {
          sessionFile: '/tmp/pi-session-lifecycle.jsonl',
          sessionId: 'pi-session-lifecycle',
        },
      }),
    )
    const events = yield* runtime.events.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
    const turnId = decodeTurnId('turn-lifecycle')
    yield* runtime.prompt({
      turnId,
      message: {
        source: 'user',
        author: decodeAuthor({
          platformUserId: 'user-1',
          mention: '<@user-1>',
          username: 'chan',
          displayName: 'Chan',
        }),
        content: { text: 'start', images: [] },
      },
      mode: 'turn',
    })
    yield* runtime.prompt({
      turnId,
      message: { source: 'user', content: { text: 'steer', images: [] } },
    })
    const delivered = yield* Fiber.join(events)
    assert.lengthOf(prompts, 2)
    assert.deepStrictEqual(
      prompts.map(({ behavior }) => behavior),
      [undefined, 'steer'],
    )
    const firstPrompt = prompts[0]
    assert.isDefined(firstPrompt)
    if (firstPrompt !== undefined) {
      assert.deepStrictEqual(decodePromptMessageEnvelope(firstPrompt.text), {
        kind: 'user-message',
        participants: [
          {
            id: 'p1',
            platformUserId: 'user-1',
            mention: '<@user-1>',
            username: 'chan',
            displayName: 'Chan',
          },
        ],
        historicalContext: [],
        trigger: { kind: 'trigger', participantId: 'p1', content: 'start' },
      })
    }
    assert.strictEqual(prompts[1]?.text, 'steer')
    assert.deepStrictEqual(
      Array.from(delivered, (event) => event.type),
      ['turn-started', 'turn-completed'],
    )
    const terminal = delivered.at(1)
    assert.strictEqual(terminal?.type, 'turn-completed')
    if (terminal?.type === 'turn-completed') {
      assert.strictEqual(terminal.agentMessage, 'FRIDAY_FAKE_OK')
      assert.deepStrictEqual(terminal.usage, {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16,
      })
    }
    const streamExit = yield* runtime.events.pipe(Stream.runDrain, Effect.exit, Effect.forkScoped)
    yield* Scope.close(scope, Exit.void)
    const closed = yield* Fiber.join(streamExit)
    assert.strictEqual(closed._tag, 'Failure')
    assert.strictEqual(unsubscribed, true)
    assert.strictEqual(abortCount, 1)
    assert.strictEqual(disposeCount, 1)
  }).pipe(Effect.provide(BunCrypto.layer)),
)

it.effect('queues steering during compaction and drains it in FIFO order', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const prompts: Array<{
        readonly text: string
        readonly behavior: 'steer' | 'followUp' | undefined
      }> = []
      let listener: ((event: AgentSessionEvent) => void | Promise<void>) | undefined
      const session = {
        sessionId: 'pi-session-compaction',
        sessionManager: { getSessionFile: () => undefined },
        subscribe: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        bindExtensions: async () => undefined,
        prompt: async (text, options) => {
          prompts.push({ text, behavior: options?.streamingBehavior })
        },
        abort: async () => undefined,
        reload: async () => undefined,
        dispose: () => undefined,
        getSessionStats: () => ({
          sessionFile: undefined,
          sessionId: 'pi-session-compaction',
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        }),
      } satisfies PiAgentSessionContract
      const thread = decodeThread({
        id: 'thread-compaction',
        audience: 'user',
        parent: null,
        harness: 'pi',
        harnessSession: null,
        workingDirectory: '/tmp/friday/thread-compaction',
        model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
        thinkingLevel: 'max',
        channelContext: { name: 'Friday test channel', description: '' },
        conversationBinding: {
          platform: 'discord',
          connectionId: 'discord',
          channelId: 'channel-compaction',
          sourceMessageId: 'message-compaction',
          conversationId: 'platform-conversation-compaction',
        },
        status: 'active',
        createdAt: '2026-03-21T09:00:00.000Z',
        updatedAt: '2026-03-21T09:00:00.000Z',
        closedAt: null,
      })
      const runtime = yield* makePiThreadRuntime({
        thread,
        sessionFactory: () => Effect.succeed(session),
      })
      yield* Effect.promise(
        () => listener?.({ type: 'compaction_start', reason: 'threshold' }) ?? Promise.resolve(),
      )
      yield* Effect.all([
        runtime.prompt({
          turnId: decodeTurnId('turn-compaction'),
          message: { source: 'user', content: { text: 'first', images: [] } },
        }),
        runtime.prompt({
          turnId: decodeTurnId('turn-compaction'),
          message: { source: 'user', content: { text: 'second', images: [] } },
        }),
      ])
      assert.deepStrictEqual(prompts, [])

      yield* Effect.promise(
        () =>
          listener?.({
            type: 'compaction_end',
            reason: 'threshold',
            result: undefined,
            aborted: false,
            willRetry: false,
          }) ?? Promise.resolve(),
      )
      assert.deepStrictEqual(prompts, [
        { text: 'first', behavior: 'steer' },
        { text: 'second', behavior: 'steer' },
      ])
    }),
  ).pipe(Effect.provide(BunCrypto.layer)),
)

it.effect('fails the active Turn without overtaking failed deferred steering', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const turnPromptStarted = yield* Deferred.make<void>()
      const finishTurnPrompt = yield* Deferred.make<void>()
      const steeringAttempts: Array<string> = []
      let listener: ((event: AgentSessionEvent) => void | Promise<void>) | undefined
      let abortCount = 0
      const session = {
        sessionId: 'pi-session-drain-failure',
        sessionManager: { getSessionFile: () => undefined },
        subscribe: (next) => {
          listener = next
          return () => {
            listener = undefined
          }
        },
        bindExtensions: async () => undefined,
        prompt: async (text, options) => {
          if (options?.streamingBehavior === 'steer') {
            steeringAttempts.push(text)
            throw new Error('steering delivery failed')
          }
          Effect.runFork(Deferred.succeed(turnPromptStarted, undefined))
          await Effect.runPromise(Deferred.await(finishTurnPrompt))
        },
        abort: async () => {
          abortCount++
          await Effect.runPromise(Deferred.succeed(finishTurnPrompt, undefined))
        },
        reload: async () => undefined,
        dispose: () => undefined,
        getSessionStats: () => ({
          sessionFile: undefined,
          sessionId: 'pi-session-drain-failure',
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        }),
      } satisfies PiAgentSessionContract
      const runtime = yield* makePiThreadRuntime({
        thread: decodeThread({
          id: 'thread-drain-failure',
          audience: 'user',
          parent: null,
          harness: 'pi',
          harnessSession: null,
          workingDirectory: '/tmp/friday/thread-drain-failure',
          model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
          thinkingLevel: 'max',
          channelContext: { name: 'Friday test channel', description: '' },
          conversationBinding: {
            platform: 'discord',
            connectionId: 'discord',
            channelId: 'channel-drain-failure',
            sourceMessageId: 'message-drain-failure',
            conversationId: 'platform-conversation-drain-failure',
          },
          status: 'active',
          createdAt: '2026-03-21T09:00:00.000Z',
          updatedAt: '2026-03-21T09:00:00.000Z',
          closedAt: null,
        }),
        sessionFactory: () => Effect.succeed(session),
      })
      const turnId = decodeTurnId('turn-drain-failure')
      const terminal = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === 'turn-completed' ||
            event.type === 'turn-interrupted' ||
            event.type === 'turn-failed',
        ),
        Stream.runHead,
        Effect.forkScoped,
      )
      yield* runtime
        .prompt({
          turnId,
          message: { source: 'user', content: { text: 'start', images: [] } },
          mode: 'turn',
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(turnPromptStarted)
      yield* Effect.promise(
        () => listener?.({ type: 'compaction_start', reason: 'threshold' }) ?? Promise.resolve(),
      )
      yield* runtime.prompt({
        turnId,
        message: { source: 'user', content: { text: 'first', images: [] } },
      })
      yield* runtime.prompt({
        turnId,
        message: { source: 'user', content: { text: 'second', images: [] } },
      })
      yield* Effect.promise(
        () =>
          listener?.({
            type: 'compaction_end',
            reason: 'threshold',
            result: undefined,
            aborted: false,
            willRetry: false,
          }) ?? Promise.resolve(),
      )
      const terminalExit = yield* Fiber.await(terminal)
      assert.strictEqual(terminalExit._tag, 'Success')
      if (terminalExit._tag !== 'Success' || terminalExit.value._tag !== 'Some') return
      assert.strictEqual(terminalExit.value.value.type, 'turn-failed')
      assert.deepStrictEqual(steeringAttempts, ['first'])
      assert.strictEqual(abortCount, 1)
    }),
  ).pipe(Effect.provide(BunCrypto.layer)),
)

it.effect('projects streamed tool snapshots into active and completed Activities', () =>
  Effect.gen(function* () {
    const events: Array<ThreadRuntimeEvent> = []
    const ids = [decodeActivityId('activity-call'), decodeActivityId('activity-result')]
    const state: PiProjectionState = {
      activeTurnId: decodeTurnId('turn-1'),
      nextSequence: 0,
      finalAgentMessage: '',
      terminalFailure: null,
      activeTools: new Map(),
    }
    const emit = (event: ThreadRuntimeEvent) =>
      Effect.sync(() => {
        events.push(event)
      })
    const makeActivityId = Effect.sync(() => ids.shift() ?? decodeActivityId('activity-extra'))

    yield* projectPiSessionEvent({
      state,
      emit,
      makeActivityId,
      event: piEvent({
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'pwd' },
      }),
    })
    yield* projectPiSessionEvent({
      state,
      emit,
      makeActivityId,
      event: piEvent({
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'pwd' },
        partialResult: {
          content: [{ type: 'text', text: '/home' }],
          details: { cwd: '/home' },
        },
      }),
    })
    yield* projectPiSessionEvent({
      state,
      emit,
      makeActivityId,
      event: piEvent({
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        result: {
          content: [{ type: 'text', text: '/home/chan' }],
          details: { cwd: '/home/chan' },
        },
        isError: false,
      }),
    })

    assert.deepStrictEqual(
      events.map(({ type }) => type),
      ['activity-completed', 'activity-started', 'activity-updated', 'activity-completed'],
    )
    const finalEvent = events.at(-1)
    assert.strictEqual(finalEvent?.type, 'activity-completed')
    if (finalEvent?.type !== 'activity-completed') return
    assert.strictEqual(finalEvent.activity.type, 'tool-result')
    if (finalEvent.activity.type !== 'tool-result') return
    assert.strictEqual(finalEvent.activity.status, 'completed')
    assert.deepStrictEqual(finalEvent.activity.output, {
      content: [{ type: 'text', text: '/home/chan' }],
      details: { cwd: '/home/chan' },
    })
    assert.strictEqual(state.activeTools.size, 0)
  }),
)

const reloadThread = (id: string) =>
  decodeThread({
    id,
    audience: 'user',
    parent: null,
    harness: 'pi',
    harnessSession: null,
    workingDirectory: `/tmp/friday/${id}`,
    model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
    thinkingLevel: 'max',
    channelContext: { name: 'Friday test channel', description: '' },
    conversationBinding: {
      platform: 'discord',
      connectionId: 'discord',
      channelId: `channel-${id}`,
      sourceMessageId: `message-${id}`,
      conversationId: `platform-conversation-${id}`,
    },
    status: 'active',
    createdAt: '2026-03-21T09:00:00.000Z',
    updatedAt: '2026-03-21T09:00:00.000Z',
    closedAt: null,
  })

const emptyStats = (sessionId: string) => ({
  sessionFile: undefined,
  sessionId,
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
})

it.effect('reloads the Pi harness session in place when the runtime is idle', () =>
  Effect.scoped(
    Effect.gen(function* () {
      let reloadCount = 0
      const session: PiAgentSessionContract = {
        sessionId: 'pi-session-reload',
        sessionManager: { getSessionFile: () => undefined },
        subscribe: () => () => undefined,
        bindExtensions: async () => undefined,
        prompt: async () => undefined,
        abort: async () => undefined,
        reload: async () => {
          reloadCount += 1
        },
        dispose: () => undefined,
        getSessionStats: () => emptyStats('pi-session-reload'),
      }
      const runtime = yield* makePiThreadRuntime({
        thread: reloadThread('thread-reload-idle'),
        sessionFactory: () => Effect.succeed(session),
      })

      const outcome = yield* runtime.reload()

      assert.deepStrictEqual(outcome, { ok: true })
      assert.strictEqual(reloadCount, 1)
      // The conversation is preserved: the session and its file are untouched.
      assert.strictEqual(runtime.harnessSession.id, 'pi-session-reload')
    }),
  ).pipe(Effect.provide(BunCrypto.layer)),
)

it.effect('refuses harness reload while a Pi Turn is active', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const turnPromptStarted = yield* Deferred.make<void>()
      const finishTurnPrompt = yield* Deferred.make<void>()
      let reloadCount = 0
      const session: PiAgentSessionContract = {
        sessionId: 'pi-session-reload-busy',
        sessionManager: { getSessionFile: () => undefined },
        subscribe: () => () => undefined,
        bindExtensions: async () => undefined,
        prompt: async (_text, options) => {
          if (options?.streamingBehavior === 'steer') return
          Effect.runFork(Deferred.succeed(turnPromptStarted, undefined))
          await Effect.runPromise(Deferred.await(finishTurnPrompt))
        },
        abort: async () => {
          await Effect.runPromise(Deferred.succeed(finishTurnPrompt, undefined))
        },
        reload: async () => {
          reloadCount += 1
        },
        dispose: () => undefined,
        getSessionStats: () => emptyStats('pi-session-reload-busy'),
      }
      const runtime = yield* makePiThreadRuntime({
        thread: reloadThread('thread-reload-busy'),
        sessionFactory: () => Effect.succeed(session),
      })
      yield* runtime
        .prompt({
          turnId: decodeTurnId('turn-reload-busy'),
          message: { source: 'user', content: { text: 'start', images: [] } },
          mode: 'turn',
        })
        .pipe(Effect.forkScoped)
      yield* Deferred.await(turnPromptStarted)

      const outcome = yield* runtime.reload()

      assert.deepStrictEqual(outcome, {
        ok: false,
        reason: 'busy',
        detail: 'A turn is active in this thread; wait for it to finish before reloading.',
      })
      assert.strictEqual(reloadCount, 0)

      yield* Deferred.succeed(finishTurnPrompt, undefined)
    }),
  ).pipe(Effect.provide(BunCrypto.layer)),
)

it.effect('reports a structured failure when the Pi reload rejects', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const session: PiAgentSessionContract = {
        sessionId: 'pi-session-reload-failure',
        sessionManager: { getSessionFile: () => undefined },
        subscribe: () => () => undefined,
        bindExtensions: async () => undefined,
        prompt: async () => undefined,
        abort: async () => undefined,
        reload: async () => {
          throw new Error('extension runner exploded')
        },
        dispose: () => undefined,
        getSessionStats: () => emptyStats('pi-session-reload-failure'),
      }
      const runtime = yield* makePiThreadRuntime({
        thread: reloadThread('thread-reload-failure'),
        sessionFactory: () => Effect.succeed(session),
      })

      const outcome = yield* runtime.reload()

      assert.deepStrictEqual(outcome, {
        ok: false,
        reason: 'reload-failed',
        detail: 'extension runner exploded',
      })
    }),
  ).pipe(Effect.provide(BunCrypto.layer)),
)
