/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- Bun SQLite integration tests cannot run under @effect/vitest because Node cannot load bun:sqlite; Effect errors use the canonical _tag discriminator. */

import { expect, test } from 'bun:test'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import {
  AgentThread,
  ChannelThread,
  HarnessSession,
  ToolResultActivity,
  Turn,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeSqliteThreadPersistence } from './SqliteThreadPersistence.ts'

const decodeHarnessSession = Schema.decodeSync(HarnessSession)
const decodeToolResultActivity = Schema.decodeSync(ToolResultActivity)
const decodeTurn = Schema.decodeSync(Turn)

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-1',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-1',
  model: { provider: 'anthropic', modelId: 'claude-sonnet' },
  thinkingLevel: 'medium',
  channelContext: { name: 'Friday test channel', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'channel-1',
    sourceMessageId: 'message-1',
    conversationId: 'platform-conversation-1',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const agentThread = Schema.decodeSync(AgentThread)({
  id: 'agent-thread-1',
  audience: 'agent',
  parent: {
    threadId: 'thread-1',
    turnId: 'turn-1',
  },
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/agent-thread-1',
  model: { provider: 'anthropic', modelId: 'claude-sonnet' },
  thinkingLevel: 'high',
  role: 'subagent',
  subagentProfile: 'primary',
  conversationBinding: null,
  status: 'active',
  createdAt: '2026-03-21T10:00:00.000Z',
  updatedAt: '2026-03-21T10:00:00.000Z',
  closedAt: null,
})

const secondAgentThread = Schema.decodeSync(AgentThread)({
  ...agentThread,
  id: 'agent-thread-2',
  parent: { threadId: thread.id, turnId: 'turn-2' },
  workingDirectory: '/tmp/friday/agent-thread-2',
  createdAt: '2026-03-21T11:00:00.000Z',
  updatedAt: '2026-03-21T11:00:00.000Z',
})

const otherParentThread = Schema.decodeSync(ChannelThread)({
  ...thread,
  id: 'thread-2',
  workingDirectory: '/tmp/friday/thread-2',
  conversationBinding: {
    ...thread.conversationBinding,
    channelId: 'channel-2',
    sourceMessageId: 'message-2',
    conversationId: 'platform-conversation-2',
  },
})

const otherAgentThread = Schema.decodeSync(AgentThread)({
  ...agentThread,
  id: 'agent-thread-other',
  parent: { threadId: otherParentThread.id, turnId: 'turn-other' },
  workingDirectory: '/tmp/friday/agent-thread-other',
})

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
  requestedAt: '2026-03-21T10:00:00.000Z',
  startedAt: null,
  completedAt: null,
  errorMessage: null,
  usage: null,
})

const activeActivity = Schema.decodeSync(ToolResultActivity)({
  id: 'activity-1',
  sequence: 0,
  status: 'active',
  type: 'tool-result',
  callId: 'call-1',
  output: 'half complete',
  isError: false,
  createdAt: '2026-03-21T10:00:01.000Z',
  updatedAt: '2026-03-21T10:00:02.000Z',
  completedAt: null,
})

const secondTurn = decodeTurn({
  ...turn,
  id: 'turn-2',
  sequence: 2,
  input: {
    source: 'user',
    content: { text: 'Continue', images: [] },
  },
})

const completedActivity = Schema.decodeSync(ToolResultActivity)({
  ...activeActivity,
  status: 'completed',
  output: 'complete',
  updatedAt: '2026-03-21T10:00:03.000Z',
  completedAt: '2026-03-21T10:00:03.000Z',
})

test('finds a Friday Thread by its Platform conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()
    yield* persistence.createThread(thread)
    const stored = yield* persistence.findPlatformThread({
      platform: thread.conversationBinding.platform,
      connectionId: thread.conversationBinding.connectionId,
      conversationId: thread.conversationBinding.conversationId,
    })
    expect(Option.getOrNull(stored)?.id).toBe(thread.id)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })))
  await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })
})

test('retrieves the latest user Turn with a platform message cursor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()
    yield* persistence.createThread(thread)
    yield* persistence.createTurn(
      decodeTurn({
        ...turn,
        input: { ...turn.input, platformMessageId: 'message-user-1' },
      }),
    )
    yield* persistence.createTurn(
      decodeTurn({
        ...secondTurn,
        input: { source: 'agent', content: { text: 'Task result.', images: [] } },
      }),
    )
    const latest = yield* persistence.getLatestUserTurn(thread.id)
    expect(String(Option.getOrNull(latest)?.input.platformMessageId)).toBe('message-user-1')
  }).pipe(Effect.provide(SqliteClient.layer({ filename })))
  await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })
})

test('retrieves the latest Turn for a Thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()
    yield* persistence.createThread(thread)
    yield* persistence.createTurn(turn)
    yield* persistence.createTurn(secondTurn)
    const latest = yield* persistence.getLatestTurn(thread.id)
    expect(String(Option.getOrNull(latest)?.id)).toBe('turn-2')
  }).pipe(Effect.provide(SqliteClient.layer({ filename })))
  await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })
})

test('creates and retrieves a channel Thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()

    yield* persistence.createThread(thread)
    return Option.getOrThrow(yield* persistence.getThread(thread.id))
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  const persisted = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })

  expect(persisted).toEqual(thread)
})

test('closes a task Thread while retaining it for history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()
    yield* persistence.createThread(agentThread)
    yield* persistence.closeThread({
      threadId: agentThread.id,
      closedAt: '2026-03-21T11:00:00.000Z',
    })
    return yield* persistence.getThread(agentThread.id)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  const stored = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })
  expect(Option.isSome(stored)).toBe(true)
  if (Option.isSome(stored)) {
    expect(stored.value.status).toBe('closed')
    expect(stored.value.closedAt).toBe('2026-03-21T11:00:00.000Z')
  }
})

test('persists a harness session cursor on its Thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const harnessSession = decodeHarnessSession({
    id: 'pi-session-1',
    resumeCursor: {
      sessionFile: '/tmp/pi-session.jsonl',
      sessionId: 'pi-session-1',
    },
  })
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()

    yield* persistence.createThread(thread)
    yield* persistence.setThreadHarnessSession({
      threadId: thread.id,
      harnessSession,
    })
    return Option.getOrThrow(yield* persistence.getThread(thread.id))
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  const persisted = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })

  expect(persisted).toEqual({ ...thread, harnessSession })
})

test('creates and retrieves an agent Thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()

    yield* persistence.createThread(agentThread)
    return Option.getOrThrow(yield* persistence.getThread(agentThread.id))
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  const persisted = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })

  expect(persisted).toEqual(agentThread)
})

test('lists agent Threads belonging to one parent in creation order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()

    yield* persistence.createThread(thread)
    yield* persistence.createThread(otherParentThread)
    yield* persistence.createThread(secondAgentThread)
    yield* persistence.createThread(otherAgentThread)
    yield* persistence.createThread(agentThread)
    return yield* persistence.listAgentThreads({ parentThreadId: thread.id })
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  const persisted = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })

  expect(persisted).toEqual([agentThread, secondAgentThread])
})

test('rejects a Turn whose Thread does not exist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()
    return yield* Effect.flip(persistence.createTurn(turn))
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  const error = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })

  expect(error._tag).toBe('PersistenceSqlError')
  expect(error.operation).toBe('ThreadPersistence.createTurn')
})

test('creates and retrieves a pending Turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()

    yield* persistence.createThread(thread)
    yield* persistence.createTurn(turn)
    const persisted = yield* persistence.getTurn(turn.id)

    return Option.getOrThrow(persisted)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  const persisted = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })

  expect(persisted).toEqual(turn)
})

test('allocates one durable Activity sequence across runtime events and steering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()
    yield* persistence.createThread(thread)
    yield* persistence.createTurn(turn)
    yield* persistence.putActivitySnapshot(turn.id, activeActivity)
    yield* persistence.putActivitySnapshot(
      turn.id,
      decodeToolResultActivity({
        ...activeActivity,
        id: 'activity-2',
        sequence: 0,
        callId: 'call-2',
      }),
    )
    const stored = yield* persistence.getTurn(turn.id)
    expect(Option.getOrNull(stored)?.activities.map(({ sequence }) => sequence)).toEqual([0, 1])
  }).pipe(Effect.provide(SqliteClient.layer({ filename })))
  await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })
})

test('persists Turn lifecycle and the latest Activity snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const program = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()

    yield* persistence.createThread(thread)
    yield* persistence.createTurn(turn)
    yield* persistence.startTurn({
      turnId: turn.id,
      harnessTurnId: null,
      startedAt: '2026-03-21T10:00:01.000Z',
    })
    yield* persistence.putActivitySnapshot(turn.id, activeActivity)
    yield* persistence.putActivitySnapshot(turn.id, {
      ...activeActivity,
      output: 'nearly complete',
      updatedAt: '2026-03-21T10:00:02.500Z',
    })
    yield* persistence.putActivitySnapshot(turn.id, completedActivity)
    yield* persistence.putActivitySnapshot(turn.id, {
      ...completedActivity,
      output: 'must not replace completed output',
      updatedAt: '2026-03-21T10:00:04.000Z',
      completedAt: '2026-03-21T10:00:04.000Z',
    })
    yield* persistence.completeTurn({
      turnId: turn.id,
      agentMessage: 'Done.',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      completedAt: '2026-03-21T10:00:05.000Z',
    })

    const persistedTurn = yield* persistence.getTurn(turn.id)
    const persistedActivity = yield* persistence.getActivity(activeActivity.id)

    return {
      turn: Option.getOrThrow(persistedTurn),
      activity: Option.getOrThrow(persistedActivity),
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  const persisted = await Effect.runPromise(program)
  await rm(directory, { recursive: true, force: true })

  expect(persisted.activity).toEqual(completedActivity)
  expect(persisted.turn).toEqual({
    ...turn,
    status: 'completed',
    startedAt: '2026-03-21T10:00:01.000Z',
    completedAt: '2026-03-21T10:00:05.000Z',
    agentMessage: 'Done.',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    activities: [completedActivity],
  })
})

test('retrieves a Turn after reopening its SQLite file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sqlite-test-'))
  const filename = join(directory, 'friday.sqlite')
  const create = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()
    yield* persistence.createThread(thread)
    yield* persistence.createTurn(turn)
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)
  const read = Effect.gen(function* () {
    const persistence = yield* makeSqliteThreadPersistence()
    return Option.getOrThrow(yield* persistence.getTurn(turn.id))
  }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

  await Effect.runPromise(create)
  const persisted = await Effect.runPromise(read)
  await rm(directory, { recursive: true, force: true })

  expect(persisted).toEqual(turn)
})
