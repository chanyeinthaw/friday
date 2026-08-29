/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- Bun SQLite integration tests cannot run under @effect/vitest because Node cannot load bun:sqlite. */

import { expect, test } from 'bun:test'
import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import { ChannelThread, HarnessSession, Turn } from '@friday/contracts/conversation'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeThreadCoordinator } from '../../conversation/ThreadCoordinator.ts'
import { ThreadPersistence } from '../../conversation/ThreadPersistence.ts'
import { makePiThreadRuntime, type PiAgentSessionContract } from './PiThreadRuntime.ts'
import { makeSqliteThreadPersistence } from '../../persistence/SqliteThreadPersistence.ts'

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-pipeline',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-pipeline',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'Friday test channel', description: '' },
  conversationBinding: {
    platform: 'discord',
    channelId: 'channel-pipeline',
    sourceMessageId: 'message-pipeline',
    conversationId: 'platform-conversation-pipeline',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const expectedHarnessSession = Schema.decodeSync(HarnessSession)({
  id: 'pi-session-pipeline',
  resumeCursor: {
    sessionFile: '/tmp/pi-session-pipeline.jsonl',
    sessionId: 'pi-session-pipeline',
  },
})

const turn = Schema.decodeSync(Turn)({
  id: 'turn-pipeline',
  threadId: thread.id,
  sequence: 1,
  input: {
    source: 'user',
    content: { text: 'Show the working directory', images: [] },
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

test('persists a fake Pi tool stream and final response through the full local pipeline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-pi-pipeline-test-'))
  const filename = join(directory, 'friday.sqlite')
  const session = makeControllableSession()
  const program = Effect.scoped(
    Effect.gen(function* () {
      const persistence = yield* makeSqliteThreadPersistence()
      yield* persistence.createThread(thread)
      const runtime = yield* makePiThreadRuntime({
        thread,
        sessionFactory: () => Effect.succeed(session.session),
      })
      const coordinator = yield* makeThreadCoordinator(runtime).pipe(
        Effect.provideService(ThreadPersistence, persistence),
      )
      yield* coordinator.start
      yield* coordinator.prompt(turn)
      const persistedTurn = yield* persistence.getTurn(turn.id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(undefined),
            onSome: (value) =>
              value.status === 'completed' ? Effect.succeed(value) : Effect.fail(undefined),
          }),
        ),
        Effect.retry(Schedule.spaced('10 millis')),
        Effect.timeoutOrElse({
          duration: Duration.seconds(2),
          orElse: () => Effect.die(new Error('Timed out waiting for persisted Turn completion')),
        }),
      )

      const persistedThread = Option.getOrThrow(yield* persistence.getThread(thread.id))
      return { persistedThread, persistedTurn }
    }),
  ).pipe(Effect.provide(Layer.mergeAll(SqliteClient.layer({ filename }), BunCrypto.layer)))

  const result = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })

  expect(result.persistedThread.harnessSession).toEqual(expectedHarnessSession)
  expect(result.persistedTurn.status).toBe('completed')
  expect(result.persistedTurn.agentMessage).toBe('The working directory is /home/chan.')
  expect(result.persistedTurn.activities.map(({ type }) => type)).toEqual([
    'tool-call',
    'tool-result',
  ])
  const resultActivity = result.persistedTurn.activities.at(1)
  expect(resultActivity?.type).toBe('tool-result')
  if (resultActivity?.type === 'tool-result') {
    expect(resultActivity.status).toBe('completed')
    expect(resultActivity.output).toBe('/home/chan')
  }
})

const makeControllableSession = () => {
  let listener: ((event: AgentSessionEvent) => void | Promise<void>) | undefined
  const emit = async (event: AgentSessionEvent) => {
    await listener?.(event)
  }
  const session = {
    sessionId: 'pi-session-pipeline',
    sessionManager: {
      getSessionFile: () => '/tmp/pi-session-pipeline.jsonl',
    },
    subscribe: (next) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
    bindExtensions: async () => undefined,
    prompt: async (_text, options) => {
      if (options?.streamingBehavior === 'steer') return
      await emit({
        type: 'tool_execution_start',
        toolCallId: 'call-pipeline',
        toolName: 'bash',
        args: { command: 'pwd' },
      })
      await emit({
        type: 'tool_execution_update',
        toolCallId: 'call-pipeline',
        toolName: 'bash',
        args: { command: 'pwd' },
        partialResult: '/home',
      })
      await emit({
        type: 'tool_execution_end',
        toolCallId: 'call-pipeline',
        toolName: 'bash',
        result: '/home/chan',
        isError: false,
      })
      await emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'The working directory is /home/chan.' }],
          api: 'anthropic-messages',
          provider: 'opencode-go',
          model: 'deepseek-v4-flash',
          usage: {
            input: 10,
            output: 7,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 17,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: 0,
        },
      })
    },
    abort: async () => undefined,
    dispose: () => undefined,
    getSessionStats: () => ({
      sessionFile: '/tmp/pi-session-pipeline.jsonl',
      sessionId: 'pi-session-pipeline',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 4,
      tokens: { input: 10, output: 7, cacheRead: 0, cacheWrite: 0, total: 17 },
      cost: 0,
    }),
  } satisfies PiAgentSessionContract
  return { session }
}
