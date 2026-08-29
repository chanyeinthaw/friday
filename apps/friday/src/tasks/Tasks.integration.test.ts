/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- Bun filesystem integration tests run through bun:test; Effect schemas use the canonical _tag discriminator. */

import { expect, test } from 'bun:test'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import {
  AgentThread,
  ChannelThread,
  IsoDateTime,
  ModelSelection,
  SubagentProfileName,
  TaskId,
  TurnId,
  WorkingDirectory,
  type AgentThread as AgentThreadType,
  type Thread,
  type Turn,
} from '@friday/contracts/conversation'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FridayContract } from '../Friday.ts'
import type { ChannelTurnsContract } from '../conversation/ChannelTurns.ts'
import type { ThreadPersistenceContract } from '../conversation/ThreadPersistence.ts'
import { makeTaskModels } from './TaskModels.ts'
import { makeTasks } from './Tasks.ts'

const decodeAgentThread = Schema.decodeSync(AgentThread)
const decodeIsoDateTime = Schema.decodeSync(IsoDateTime)
const decodeModelSelection = Schema.decodeSync(ModelSelection)
const decodeProfileName = Schema.decodeSync(SubagentProfileName)
const decodeTaskId = Schema.decodeSync(TaskId)
const decodeTurnId = Schema.decodeSync(TurnId)
const decodeWorkingDirectory = Schema.decodeSync(WorkingDirectory)

const decodeChannelThread = Schema.decodeSync(ChannelThread)

const parentThread = (workingDirectory: string) =>
  decodeChannelThread({
    id: 'thread-task-parent',
    audience: 'user',
    parent: null,
    harness: 'pi',
    harnessSession: null,
    workingDirectory,
    model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
    thinkingLevel: 'max',
    channelContext: { name: 'task-test', description: '' },
    conversationBinding: {
      platform: 'discord',
      channelId: 'channel-task-test',
      sourceMessageId: 'message-task-test',
      conversationId: 'conversation-task-test',
    },
    status: 'active',
    createdAt: '2026-03-21T09:00:00.000Z',
    updatedAt: '2026-03-21T09:00:00.000Z',
    closedAt: null,
  })

const makePersistence = (
  parent: ReturnType<typeof parentThread>,
  createdThreads: Array<Thread>,
): ThreadPersistenceContract => ({
  createThread: (thread) => Effect.sync(() => createdThreads.push(thread)).pipe(Effect.asVoid),
  getThread: (threadId) =>
    Effect.succeed(threadId === parent.id ? Option.some(parent) : Option.none()),
  findPlatformThread: () => Effect.succeedNone,
  listAgentThreads: () => Effect.succeed([]),
  closeThread: () => Effect.void,
  setThreadHarnessSession: () => Effect.void,
  createTurn: () => Effect.void,
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

const noChannelTurns: ChannelTurnsContract = { accept: () => Effect.void }
const profilesFor = (parent: ReturnType<typeof parentThread>) => [
  {
    name: decodeProfileName('primary'),
    description: 'General delegated work.',
    model: parent.model,
    thinkingLevel: 'max' as const,
  },
]

const makeFriday = (promptedTurns: Array<Turn>): FridayContract => ({
  openThread: (_thread) =>
    Effect.succeed({
      prompt: (turn) =>
        Effect.sync(() => promptedTurns.push(turn)).pipe(
          Effect.as({ turnId: turn.id, awaitTerminal: Effect.never }),
        ),
      steer: () => Effect.void,
      cancel: () => Effect.void,
      onEvent: () => Effect.void,
      start: Effect.void,
      drain: Effect.never,
    }),
})

test('starts a subagent task without waiting for its terminal result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-task-test-'))
  const channelWorkspace = join(root, 'channel')
  const projectDirectory = join(channelWorkspace, 'project')
  await Promise.all([
    Bun.write(join(channelWorkspace, '.keep'), ''),
    Bun.write(join(projectDirectory, '.keep'), ''),
  ])

  const parent = parentThread(channelWorkspace)
  const createdThreads: Array<Thread> = []
  const promptedTurns: Array<Turn> = []
  const identifiers = ['task-id', 'turn-id']
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence: makePersistence(parent, createdThreads),
      friday: makeFriday(promptedTurns),
      models: makeTaskModels(profilesFor(parent)),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.sync(() => identifiers.shift() ?? 'unexpected-id'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.void,
    })

    return yield* tasks.start({
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-parent'),
      task: 'Inspect the repository and report the result.',
      workingDirectory: decodeWorkingDirectory(projectDirectory),
    })
  }).pipe(Effect.provide(BunFileSystem.layer))

  const started = await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })

  expect(started.status).toBe('pending')
  expect(String(started.taskId)).toBe('task-task-id')
  expect(createdThreads).toHaveLength(1)
  expect(promptedTurns).toHaveLength(1)
  const taskThread = createdThreads[0]
  expect(taskThread?.audience).toBe('agent')
  if (taskThread?.audience === 'agent') {
    expect(taskThread.role).toBe('subagent')
    expect(String(taskThread.workingDirectory)).toBe(projectDirectory)
  }
  expect(promptedTurns[0]?.input.source).toBe('agent')
  expect(promptedTurns[0]?.input.content.text).toBe('Inspect the repository and report the result.')
})

test('applies the selected subagent profile model and thinking level', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-task-profile-'))
  const channelWorkspace = join(root, 'channel')
  const projectDirectory = join(channelWorkspace, 'project')
  await Promise.all([
    Bun.write(join(channelWorkspace, '.keep'), ''),
    Bun.write(join(projectDirectory, '.keep'), ''),
  ])
  const parent = parentThread(channelWorkspace)
  const profileName = decodeProfileName('review')
  const createdThreads: Array<Thread> = []
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence: makePersistence(parent, createdThreads),
      friday: makeFriday([]),
      models: makeTaskModels([
        ...profilesFor(parent),
        {
          name: profileName,
          description: 'Focused review work.',
          model: decodeModelSelection({ provider: 'anthropic', modelId: 'claude-opus' }),
          thinkingLevel: 'high',
        },
      ]),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.succeed('profile-task'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.void,
    })
    return yield* tasks.start({
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-parent'),
      task: 'Review the project.',
      workingDirectory: decodeWorkingDirectory(projectDirectory),
      profile: profileName,
    })
  }).pipe(Effect.provide(BunFileSystem.layer))

  await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })

  const thread = createdThreads[0]
  expect(String(thread?.model.provider)).toBe('anthropic')
  expect(String(thread?.model.modelId)).toBe('claude-opus')
  expect(thread?.thinkingLevel).toBe('high')
})

test('starts a bootstrap task in the channel workspace with the bootstrap role', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-bootstrap-test-'))
  const channelWorkspace = join(root, 'channel')
  await Bun.write(join(channelWorkspace, '.keep'), '')

  const parent = parentThread(channelWorkspace)
  const createdThreads: Array<Thread> = []
  const promptedTurns: Array<Turn> = []
  const identifiers = ['bootstrap-id', 'bootstrap-turn']
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence: makePersistence(parent, createdThreads),
      friday: makeFriday(promptedTurns),
      models: makeTaskModels(profilesFor(parent)),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.sync(() => identifiers.shift() ?? 'unexpected-id'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.void,
    })

    return yield* tasks.bootstrap({
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-parent'),
      task: 'Prepare /tmp/project for a separate implementation agent.',
    })
  }).pipe(Effect.provide(BunFileSystem.layer))

  const started = await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })

  expect(String(started.taskId)).toBe('task-bootstrap-id')
  expect(createdThreads).toHaveLength(1)
  const bootstrapThread = createdThreads[0]
  expect(bootstrapThread?.audience).toBe('agent')
  if (bootstrapThread?.audience === 'agent') {
    expect(bootstrapThread.role).toBe('bootstrap')
    expect(String(bootstrapThread.workingDirectory)).toBe(channelWorkspace)
  }
  expect(promptedTurns[0]?.input.content.text).toBe(
    'Prepare /tmp/project for a separate implementation agent.',
  )
})

test('delivers a completed task back to the parent channel Thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-task-test-'))
  const channelWorkspace = join(root, 'channel')
  const projectDirectory = join(channelWorkspace, 'project')
  await Promise.all([
    Bun.write(join(channelWorkspace, '.keep'), ''),
    Bun.write(join(projectDirectory, '.keep'), ''),
  ])
  const parent = parentThread(channelWorkspace)
  const terminal = yieldableDeferred()
  const closed: Array<string> = []
  const delivered: Array<{ readonly source: string; readonly text: string }> = []
  const friday: FridayContract = {
    openThread: () =>
      Effect.succeed({
        prompt: (turn) =>
          Effect.succeed({
            turnId: turn.id,
            awaitTerminal: Deferred.await(terminal.deferred),
          }),
        steer: () => Effect.void,
        cancel: () => Effect.void,
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.never,
      }),
  }
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence: {
        ...makePersistence(parent, []),
        closeThread: ({ threadId }) => Effect.sync(() => closed.push(threadId)),
      },
      friday,
      models: makeTaskModels(profilesFor(parent)),
      channelTurns: {
        accept: ({ message }) =>
          Effect.sync(() => delivered.push({ source: message.source, text: message.content.text })),
      },
      fileSystem,
      randomUUID: Effect.sync(() => terminal.identifiers.shift() ?? 'unexpected-id'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: (effect) => effect.pipe(Effect.forkChild, Effect.asVoid),
    })
    const started = yield* tasks.start({
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-parent'),
      task: 'Complete the delegated work.',
      workingDirectory: decodeWorkingDirectory(projectDirectory),
    })
    yield* Deferred.succeed(terminal.deferred, {
      status: 'completed' as const,
      turnId: decodeTurnId('turn-terminal'),
      agentMessage: 'Delegated result.',
      usage: null,
    })
    yield* Effect.yieldNow
    return started
  }).pipe(Effect.provide(BunFileSystem.layer))

  const started = await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })

  expect(String(started.taskId)).toBe('task-task-completion')
  expect(closed).toEqual(['task-task-completion'])
  expect(delivered).toEqual([
    {
      source: 'agent',
      text: 'Task task-task-completion completed.\n\nResult:\nDelegated result.',
    },
  ])
})

const yieldableDeferred = () => {
  const runtime = Effect.runSync(
    Deferred.make<{
      readonly status: 'completed'
      readonly turnId: ReturnType<typeof decodeTurnId>
      readonly agentMessage: string
      readonly usage: null
    }>(),
  )
  return { deferred: runtime, identifiers: ['task-completion', 'turn-completion'] }
}

test('delivers a bootstrap result back to the channel for a separate normal task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-bootstrap-test-'))
  const channelWorkspace = join(root, 'channel')
  await Bun.write(join(channelWorkspace, '.keep'), '')
  const parent = parentThread(channelWorkspace)
  const terminal = yieldableDeferred()
  const delivered: Array<string> = []
  const friday: FridayContract = {
    openThread: () =>
      Effect.succeed({
        prompt: (turn) =>
          Effect.succeed({ turnId: turn.id, awaitTerminal: Deferred.await(terminal.deferred) }),
        steer: () => Effect.void,
        cancel: () => Effect.void,
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.never,
      }),
  }
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence: makePersistence(parent, []),
      friday,
      models: makeTaskModels(profilesFor(parent)),
      channelTurns: {
        accept: ({ message }) => Effect.sync(() => delivered.push(message.content.text)),
      },
      fileSystem,
      randomUUID: Effect.sync(() => terminal.identifiers.shift() ?? 'unexpected-id'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: (effect) => effect.pipe(Effect.forkChild, Effect.asVoid),
    })
    const started = yield* tasks.bootstrap({
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-parent'),
      task: 'Prepare the repository.',
    })
    yield* Deferred.succeed(terminal.deferred, {
      status: 'completed' as const,
      turnId: decodeTurnId('turn-terminal'),
      agentMessage: `Working directory ready: ${join(root, 'project')}`,
      usage: null,
    })
    yield* Effect.yieldNow
    return started
  }).pipe(Effect.provide(BunFileSystem.layer))

  const started = await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })

  expect(delivered).toEqual([
    `Task ${started.taskId} completed.\n\nResult:\nWorking directory ready: ${join(root, 'project')}`,
  ])
})

test('lists tasks by the latest Turn status', async () => {
  const parent = parentThread('/tmp/channel')
  const thread = decodeAgentThread({
    id: 'task-listed',
    audience: 'agent',
    parent: { threadId: parent.id, turnId: 'turn-parent' },
    role: 'subagent',
    subagentProfile: 'primary',
    harness: 'pi',
    harnessSession: null,
    workingDirectory: '/tmp/project',
    model: parent.model,
    thinkingLevel: parent.thinkingLevel,
    conversationBinding: null,
    status: 'active',
    createdAt: '2026-03-21T10:00:00.000Z',
    updatedAt: '2026-03-21T10:00:00.000Z',
    closedAt: null,
  })
  const first = taskTurn(thread, 'turn-first', 1, 'pending', 'Original task')
  const latest = taskTurn(thread, 'turn-latest', 2, 'completed', 'Follow-up')
  const tasks = makeTasks({
    persistence: taskPersistence(parent, thread, first, latest),
    friday: makeFriday([]),
    models: makeTaskModels(profilesFor(parent)),
    channelTurns: noChannelTurns,
    fileSystem: Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer))),
    randomUUID: Effect.succeed('unused'),
    now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
    fork: () => Effect.void,
  })

  const terminal = await Effect.runPromise(
    tasks.list({ parentThreadId: parent.id, status: 'terminal' }),
  )
  const active = await Effect.runPromise(
    tasks.list({ parentThreadId: parent.id, status: 'active' }),
  )

  expect(terminal).toEqual([
    expect.objectContaining({
      taskId: decodeTaskId('task-listed'),
      status: 'completed',
      task: 'Original task',
      completedAt: latest.completedAt,
    }),
  ])
  expect(active).toEqual([])
})

test('steers an active task and continues an idle task with a new Turn', async () => {
  const parent = parentThread('/tmp/channel')
  const thread = taskThread(parent)
  const active = taskTurn(thread, 'turn-active', 1, 'running', 'Original task')
  const steered: Array<string> = []
  const prompted: Array<Turn> = []
  const friday: FridayContract = {
    openThread: () =>
      Effect.succeed({
        prompt: (turn) =>
          Effect.sync(() => prompted.push(turn)).pipe(
            Effect.as({ turnId: turn.id, awaitTerminal: Effect.never }),
          ),
        steer: (_turnId, activity) =>
          Effect.sync(() => steered.push(activity.message.content.text)),
        cancel: () => Effect.void,
        onEvent: () => Effect.void,
        start: Effect.void,
        drain: Effect.never,
      }),
  }
  let latest = active
  const persistence = taskPersistence(parent, thread, active, latest)
  const tasks = makeTasks({
    persistence: { ...persistence, getLatestTurn: () => Effect.succeedSome(latest) },
    friday,
    models: makeTaskModels(profilesFor(parent)),
    channelTurns: noChannelTurns,
    fileSystem: Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer))),
    randomUUID: Effect.succeed('continuation'),
    now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
    fork: () => Effect.void,
  })

  await Effect.runPromise(
    tasks.steer({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      message: 'Redirect.',
    }),
  )
  expect(steered).toEqual(['Redirect.'])

  latest = taskTurn(thread, 'turn-completed', 1, 'completed', 'Original task')
  await Effect.runPromise(
    tasks.steer({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      message: 'Continue.',
    }),
  )
  expect(prompted).toHaveLength(1)
  expect(prompted[0]?.sequence).toBe(2)
  expect(prompted[0]?.input.content.text).toBe('Continue.')
})

test('cancels only an active owned task', async () => {
  const parent = parentThread('/tmp/channel')
  const thread = taskThread(parent)
  const active = taskTurn(thread, 'turn-active', 1, 'running', 'Original task')
  const cancelled: Array<string> = []
  const delivered: Array<string> = []
  const tasks = makeTasks({
    persistence: taskPersistence(parent, thread, active, active),
    friday: {
      openThread: () =>
        Effect.succeed({
          prompt: () => Effect.die('not expected'),
          steer: () => Effect.die('not expected'),
          cancel: (turnId) => Effect.sync(() => cancelled.push(turnId)),
          onEvent: () => Effect.void,
          start: Effect.void,
          drain: Effect.never,
        }),
    },
    models: makeTaskModels(profilesFor(parent)),
    channelTurns: {
      accept: ({ message }) => Effect.sync(() => delivered.push(message.content.text)),
    },
    fileSystem: Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer))),
    randomUUID: Effect.succeed('unused'),
    now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
    fork: () => Effect.void,
  })

  await Effect.runPromise(
    tasks.cancel({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      reason: 'No longer needed.',
    }),
  )
  expect(cancelled).toEqual([active.id])
  expect(delivered).toEqual([
    'Task task-owned cancellation was requested.\n\nReason:\nNo longer needed.',
  ])
})

test('rejects task operations from another channel', async () => {
  const owner = parentThread('/tmp/channel-owner')
  const other = decodeChannelThread({
    ...parentThread('/tmp/channel-other'),
    id: 'thread-task-other',
    conversationBinding: {
      ...parentThread('/tmp/channel-other').conversationBinding,
      channelId: 'channel-task-other',
      sourceMessageId: 'message-task-other',
      conversationId: 'conversation-task-other',
    },
  })
  const thread = taskThread(owner)
  const active = taskTurn(thread, 'turn-active', 1, 'running', 'Original task')
  const base = taskPersistence(owner, thread, active, active)
  const tasks = makeTasks({
    persistence: {
      ...base,
      getThread: (threadId) =>
        Effect.succeed(
          threadId === other.id
            ? Option.some(other)
            : threadId === thread.id
              ? Option.some(thread)
              : Option.none(),
        ),
    },
    friday: makeFriday([]),
    models: makeTaskModels(profilesFor(owner)),
    channelTurns: noChannelTurns,
    fileSystem: Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer))),
    randomUUID: Effect.succeed('unused'),
    now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
    fork: () => Effect.void,
  })

  const error = await Effect.runPromise(
    Effect.flip(
      tasks.cancel({
        parentThreadId: other.id,
        taskId: decodeTaskId(thread.id),
        reason: 'Not owned.',
      }),
    ),
  )

  expect(error._tag).toBe('TaskError')
  if (error._tag === 'TaskError') expect(error.reason).toBe('task-not-owned')
})

test('rejects cancellation for a terminal task', async () => {
  const parent = parentThread('/tmp/channel')
  const thread = taskThread(parent)
  const completed = taskTurn(thread, 'turn-completed', 1, 'completed', 'Original task')
  const tasks = makeTasks({
    persistence: taskPersistence(parent, thread, completed, completed),
    friday: makeFriday([]),
    models: makeTaskModels(profilesFor(parent)),
    channelTurns: noChannelTurns,
    fileSystem: Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(BunFileSystem.layer))),
    randomUUID: Effect.succeed('unused'),
    now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
    fork: () => Effect.void,
  })

  const error = await Effect.runPromise(
    Effect.flip(
      tasks.cancel({
        parentThreadId: parent.id,
        taskId: decodeTaskId(thread.id),
        reason: 'Too late.',
      }),
    ),
  )

  expect(error._tag).toBe('TaskError')
  if (error._tag === 'TaskError') expect(error.reason).toBe('task-not-active')
})

test('rejects concurrent tasks sharing one canonical working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-task-concurrency-'))
  const channelWorkspace = join(root, 'channel')
  const projectDirectory = join(channelWorkspace, 'project')
  await Promise.all([
    Bun.write(join(channelWorkspace, '.keep'), ''),
    Bun.write(join(projectDirectory, '.keep'), ''),
  ])
  const parent = parentThread(channelWorkspace)
  const existing = decodeAgentThread({
    ...taskThread(parent),
    id: 'task-existing',
    workingDirectory: projectDirectory,
  })
  const running = taskTurn(existing, 'turn-running', 1, 'running', 'Existing task')
  const persistence: ThreadPersistenceContract = {
    ...makePersistence(parent, []),
    listAgentThreads: () => Effect.succeed([existing]),
    getLatestTurn: () => Effect.succeedSome(running),
  }
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence,
      friday: makeFriday([]),
      models: makeTaskModels(profilesFor(parent)),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.succeed('unused'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.void,
    })
    return yield* Effect.flip(
      tasks.start({
        parentThreadId: parent.id,
        parentTurnId: decodeTurnId('turn-parent'),
        task: 'Conflicting task.',
        workingDirectory: decodeWorkingDirectory(projectDirectory),
      }),
    )
  }).pipe(Effect.provide(BunFileSystem.layer))

  const error = await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })

  expect(error._tag).toBe('TaskError')
  if (error._tag === 'TaskError') expect(error.reason).toBe('working-directory-busy')
})

test('rejects an unconfigured task model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-task-test-'))
  const channelWorkspace = join(root, 'channel')
  const projectDirectory = join(channelWorkspace, 'project')
  await Promise.all([
    Bun.write(join(channelWorkspace, '.keep'), ''),
    Bun.write(join(projectDirectory, '.keep'), ''),
  ])
  const parent = parentThread(channelWorkspace)
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence: makePersistence(parent, []),
      friday: makeFriday([]),
      models: makeTaskModels([]),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.succeed('unused'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.void,
    })

    return yield* Effect.flip(
      tasks.start({
        parentThreadId: parent.id,
        parentTurnId: decodeTurnId('turn-parent'),
        task: 'Do work.',
        workingDirectory: decodeWorkingDirectory(projectDirectory),
      }),
    )
  }).pipe(Effect.provide(BunFileSystem.layer))

  const error = await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })

  expect(error._tag).toBe('TaskError')
  if (error._tag === 'TaskError') expect(error.reason).toBe('model-not-configured')
})

const taskThread = (parent: ReturnType<typeof parentThread>): AgentThreadType =>
  decodeAgentThread({
    id: 'task-owned',
    audience: 'agent',
    parent: { threadId: parent.id, turnId: 'turn-parent' },
    role: 'subagent',
    subagentProfile: 'primary',
    harness: 'pi',
    harnessSession: null,
    workingDirectory: '/tmp/project',
    model: parent.model,
    thinkingLevel: parent.thinkingLevel,
    conversationBinding: null,
    status: 'active',
    createdAt: '2026-03-21T10:00:00.000Z',
    updatedAt: '2026-03-21T10:00:00.000Z',
    closedAt: null,
  })

const taskTurn = (
  thread: AgentThreadType,
  id: string,
  sequence: number,
  status: Turn['status'],
  text: string,
): Turn => ({
  id: decodeTurnId(id),
  threadId: thread.id,
  sequence,
  input: { source: 'agent', content: { text, images: [] } },
  agentMessage: status === 'completed' ? 'Done.' : null,
  activities: [],
  model: thread.model,
  thinkingLevel: thread.thinkingLevel,
  harnessTurnId: null,
  status,
  requestedAt: decodeIsoDateTime('2026-03-21T10:00:00.000Z'),
  startedAt: status === 'pending' ? null : decodeIsoDateTime('2026-03-21T10:01:00.000Z'),
  completedAt:
    status === 'completed' || status === 'interrupted' || status === 'failed'
      ? decodeIsoDateTime('2026-03-21T10:02:00.000Z')
      : null,
  errorMessage: status === 'failed' ? 'Failed.' : null,
  usage: null,
})

const taskPersistence = (
  parent: ReturnType<typeof parentThread>,
  thread: AgentThreadType,
  first: Turn,
  latest: Turn,
): ThreadPersistenceContract => ({
  ...makePersistence(parent, []),
  getThread: (threadId) =>
    Effect.succeed(
      threadId === parent.id
        ? Option.some(parent)
        : threadId === thread.id
          ? Option.some(thread)
          : Option.none(),
    ),
  listAgentThreads: () => Effect.succeed([thread]),
  getFirstTurn: () => Effect.succeedSome(first),
  getLatestTurn: () => Effect.succeedSome(latest),
})

test('rejects directories outside the channel workspace for a normal task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-task-test-'))
  const channelWorkspace = join(root, 'channel')
  const externalWorkspace = join(root, 'external-project')
  await Bun.write(join(channelWorkspace, '.keep'), '')
  await Bun.write(join(externalWorkspace, '.keep'), '')
  const parent = parentThread(channelWorkspace)
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence: makePersistence(parent, []),
      friday: makeFriday([]),
      models: makeTaskModels([]),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.succeed('unused'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.void,
    })
    const request = {
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-parent'),
      task: 'Do work.',
      workingDirectory: decodeWorkingDirectory(externalWorkspace),
    } as const

    const workspaceError = yield* Effect.flip(tasks.start(request))
    expect(workspaceError._tag).toBe('TaskError')
    if (workspaceError._tag === 'TaskError') {
      expect(workspaceError.reason).toBe('outside-channel-workspace')
    }
  }).pipe(Effect.provide(BunFileSystem.layer))

  await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })
})

test('rejects the channel workspace root for a normal task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-task-test-'))
  const channelWorkspace = join(root, 'channel')
  await Bun.write(join(channelWorkspace, '.keep'), '')
  const parent = parentThread(channelWorkspace)
  const program = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence: makePersistence(parent, []),
      friday: makeFriday([]),
      models: makeTaskModels([]),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.succeed('unused'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.void,
    })
    const workingDirectory = decodeWorkingDirectory(channelWorkspace)
    const request = {
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-parent'),
      task: 'Do work.',
      workingDirectory,
    } as const

    const workspaceError = yield* Effect.flip(tasks.start(request))
    expect(workspaceError._tag).toBe('TaskError')
    if (workspaceError._tag === 'TaskError') expect(workspaceError.reason).toBe('channel-workspace')
  }).pipe(Effect.provide(BunFileSystem.layer))

  await Effect.runPromise(program)
  await rm(root, { recursive: true, force: true })
})
