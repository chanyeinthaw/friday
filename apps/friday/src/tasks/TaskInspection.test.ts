import {
  ActivityId,
  AgentThread,
  ChannelThread,
  InspectTaskRequest,
  IsoDateTime,
  TaskId,
  TaskInspectCursor,
  ThreadId,
  ToolCallId,
  TurnId,
  type Activity,
  type AgentThread as AgentThreadType,
  type Turn,
} from '@friday/contracts/conversation'
import { assert, it } from '@effect/vitest'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { FridayContract } from '../Friday.ts'
import type { ChannelTurnsContract } from '../conversation/ChannelTurns.ts'
import type { ThreadPersistenceContract } from '../conversation/ThreadPersistence.ts'
import { makeTaskModels } from './TaskModels.ts'
import {
  buildTaskActivities,
  buildTaskOutline,
  decodeInspectCursor,
  encodeInspectCursor,
  relativeWorkspacePath,
} from './TaskInspection.ts'
import { makeTasks } from './Tasks.ts'

const decodeActivityId = Schema.decodeSync(ActivityId)
const decodeAgentThread = Schema.decodeSync(AgentThread)
const decodeCallId = Schema.decodeSync(ToolCallId)
const decodeChannelThread = Schema.decodeSync(ChannelThread)
const decodeInspectRequest = Schema.decodeUnknownEffect(InspectTaskRequest)
const decodeIsoDateTime = Schema.decodeSync(IsoDateTime)
const decodeTaskId = Schema.decodeSync(TaskId)
const decodeCursor = Schema.decodeSync(TaskInspectCursor)
const decodeThreadId = Schema.decodeSync(ThreadId)
const decodeTurnId = Schema.decodeSync(TurnId)

const parent = decodeChannelThread({
  id: 'thread-inspect-parent',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/workspace/channel',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'inspect', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'channel-inspect',
    sourceMessageId: 'message-inspect',
    conversationId: 'conversation-inspect',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

interface TaskThreadOverrides {
  readonly id?: string
  readonly status?: 'active' | 'closed'
  readonly harnessSession?: {
    readonly id: string
    readonly resumeCursor: Record<string, string>
  } | null
  readonly workingDirectory?: string
}

const taskThread = (overrides: TaskThreadOverrides = {}): AgentThreadType =>
  decodeAgentThread({
    id: overrides.id ?? 'task-owned',
    audience: 'agent',
    parent: { threadId: parent.id, turnId: 'turn-parent' },
    role: 'subagent',
    subagentProfile: 'primary',
    harness: 'pi',
    harnessSession: overrides.harnessSession === undefined ? null : overrides.harnessSession,
    workingDirectory: overrides.workingDirectory ?? '/workspace/channel/project',
    model: parent.model,
    thinkingLevel: parent.thinkingLevel,
    conversationBinding: null,
    status: overrides.status ?? 'active',
    createdAt: '2026-03-21T10:00:00.000Z',
    updatedAt: '2026-03-21T10:00:00.000Z',
    closedAt: null,
  })

const baseTurn = (
  thread: AgentThreadType,
  id: string,
  sequence: number,
  status: Turn['status'],
  text: string,
  activities: ReadonlyArray<Activity> = [],
): Turn => ({
  id: decodeTurnId(id),
  threadId: decodeThreadId(thread.id),
  sequence,
  input: { source: 'agent', content: { text, images: [] } },
  agentMessage: status === 'completed' ? 'Done.' : null,
  activities: [...activities],
  model: parent.model,
  thinkingLevel: parent.thinkingLevel,
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

type ToolCallInput = Extract<Activity, { readonly type: 'tool-call' }>['input']
type ToolResultOutput = Extract<Activity, { readonly type: 'tool-result' }>['output']

const toolCall = (
  sequence: number,
  callId: string,
  toolName: string,
  input: ToolCallInput,
): Extract<Activity, { readonly type: 'tool-call' }> => ({
  id: decodeActivityId(`activity-call-${callId}`),
  sequence,
  status: 'completed',
  type: 'tool-call',
  callId: decodeCallId(callId),
  toolName,
  input,
  createdAt: decodeIsoDateTime('2026-03-21T10:01:00.000Z'),
  updatedAt: decodeIsoDateTime('2026-03-21T10:01:00.000Z'),
  completedAt: decodeIsoDateTime('2026-03-21T10:01:00.000Z'),
})

const toolResult = (
  sequence: number,
  callId: string,
  output: ToolResultOutput,
  status: 'active' | 'completed' = 'completed',
  isError = false,
): Extract<Activity, { readonly type: 'tool-result' }> => ({
  id: decodeActivityId(`activity-result-${callId}`),
  sequence,
  status,
  type: 'tool-result',
  callId: decodeCallId(callId),
  output,
  isError,
  createdAt: decodeIsoDateTime('2026-03-21T10:01:01.000Z'),
  updatedAt: decodeIsoDateTime('2026-03-21T10:01:02.000Z'),
  completedAt: status === 'completed' ? decodeIsoDateTime('2026-03-21T10:01:02.000Z') : null,
})

const steering = (
  sequence: number,
  id: string,
  text: string,
): Extract<Activity, { readonly type: 'steering' }> => ({
  id: decodeActivityId(id),
  sequence,
  status: 'completed',
  type: 'steering',
  message: { source: 'agent', content: { text, images: [] } },
  createdAt: decodeIsoDateTime('2026-03-21T10:01:03.000Z'),
  updatedAt: decodeIsoDateTime('2026-03-21T10:01:03.000Z'),
  completedAt: decodeIsoDateTime('2026-03-21T10:01:03.000Z'),
})

const commentary = (
  sequence: number,
  id: string,
): Extract<Activity, { readonly type: 'commentary' }> => ({
  id: decodeActivityId(id),
  sequence,
  status: 'completed',
  type: 'commentary',
  text: 'Raw assistant text that must never surface.',
  createdAt: decodeIsoDateTime('2026-03-21T10:01:04.000Z'),
  updatedAt: decodeIsoDateTime('2026-03-21T10:01:04.000Z'),
  completedAt: decodeIsoDateTime('2026-03-21T10:01:04.000Z'),
})

const stubPersistence = (
  thread: AgentThreadType,
  turns: Array<Turn>,
): ThreadPersistenceContract => ({
  createThread: () => Effect.void,
  getThread: (threadId) =>
    Effect.succeed(
      threadId === parent.id
        ? Option.some(parent)
        : threadId === thread.id
          ? Option.some(thread)
          : Option.none(),
    ),
  findPlatformThread: () => Effect.succeedNone,
  listAgentThreads: () => Effect.succeed([]),
  closeThread: () => Effect.void,
  setThreadHarnessSession: () => Effect.void,
  createTurn: () => Effect.void,
  getTurn: () => Effect.succeedNone,
  getFirstTurn: () => Effect.succeed(Option.fromNullishOr(turns.at(0))),
  getLatestTurn: () => Effect.succeed(Option.fromNullishOr(turns.at(-1))),
  listTurns: () => Effect.succeed(turns),
  getLatestUserTurn: () => Effect.succeedNone,
  startTurn: () => Effect.void,
  putActivitySnapshot: () => Effect.void,
  getActivity: () => Effect.succeedNone,
  completeTurn: () => Effect.void,
  interruptTurn: () => Effect.void,
  failTurn: () => Effect.void,
})

const readOnlyFriday = (runtime: {
  readonly runtimePresent: boolean
  readonly activeTurns: number
}): FridayContract => ({
  openThread: () => Effect.die('inspect must be read-only'),
  observeRuntime: () => Effect.succeed(runtime),
})

const noChannelTurns: ChannelTurnsContract = {
  accept: () => Effect.die('inspect must be read-only'),
}

const inspectWith = (
  thread: AgentThreadType,
  turns: Array<Turn>,
  runtime: { readonly runtimePresent: boolean; readonly activeTurns: number } = {
    runtimePresent: false,
    activeTurns: 0,
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    return makeTasks({
      persistence: stubPersistence(thread, turns),
      friday: readOnlyFriday(runtime),
      models: makeTaskModels(() => []),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.succeed('unused'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.die('inspect must be read-only'),
    })
  }).pipe(Effect.provide(NodeFileSystem.layer))

it.effect('rejects invalid inspect input through the Effect contract schema', () =>
  Effect.gen(function* () {
    const taskId = decodeTaskId('task-owned')
    const valid = yield* decodeInspectRequest({ parentThreadId: parent.id, taskId })
    assert.strictEqual(String(valid.taskId), 'task-owned')

    const emptyTask = yield* Effect.exit(
      decodeInspectRequest({ parentThreadId: parent.id, taskId: '  ' }),
    )
    assert.strictEqual(emptyTask._tag, 'Failure')

    const emptyCursor = yield* Effect.exit(
      decodeInspectRequest({ parentThreadId: parent.id, taskId, cursor: '  ' }),
    )
    assert.strictEqual(emptyCursor._tag, 'Failure')

    const zeroLimit = yield* Effect.exit(
      decodeInspectRequest({ parentThreadId: parent.id, taskId, limit: 0 }),
    )
    assert.strictEqual(zeroLimit._tag, 'Failure')

    const overLimit = yield* Effect.exit(
      decodeInspectRequest({ parentThreadId: parent.id, taskId, limit: 21 }),
    )
    assert.strictEqual(overLimit._tag, 'Failure')
  }),
)

it.effect('returns five activities by default and honors an explicit limit', () =>
  Effect.gen(function* () {
    const thread = taskThread()
    const activities: Array<Activity> = []
    for (let index = 0; index < 7; index += 1) {
      activities.push(
        toolCall(index * 2, `call-${index}`, 'read', { intent: `Read file ${index}` }),
      )
      activities.push(toolResult(index * 2 + 1, `call-${index}`, `output-${index}`))
    }
    const turn = baseTurn(thread, 'turn-1', 1, 'running', 'Raw task prompt', activities)
    const tasks = yield* inspectWith(thread, [turn])

    const byDefault = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
    })
    assert.strictEqual(byDefault.activities.length, 5)
    assert.strictEqual(byDefault.hasMore, true)
    assert.notStrictEqual(byDefault.nextCursor, null)

    const limited = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      limit: 2,
    })
    assert.strictEqual(limited.activities.length, 2)
    assert.strictEqual(limited.hasMore, true)
  }),
)

it.effect('caps pagination at twenty activities', () =>
  Effect.gen(function* () {
    const thread = taskThread()
    const activities: Array<Activity> = []
    for (let index = 0; index < 22; index += 1) {
      activities.push(toolCall(index * 2, `call-${index}`, 'read', { intent: `Read ${index}` }))
      activities.push(toolResult(index * 2 + 1, `call-${index}`, `out-${index}`))
    }
    const turn = baseTurn(thread, 'turn-1', 1, 'running', 'Raw task prompt', activities)
    const tasks = yield* inspectWith(thread, [turn])

    const page = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      limit: 20,
    })
    assert.strictEqual(page.activities.length, 20)
    assert.strictEqual(page.hasMore, true)
  }),
)

it.effect('paginates newest-first across turns including continuations', () =>
  Effect.gen(function* () {
    const thread = taskThread()
    const first = baseTurn(thread, 'turn-1', 1, 'completed', 'Raw task prompt', [
      toolCall(0, 'call-old', 'read', { intent: 'Read old file' }),
      toolResult(1, 'call-old', 'old-output'),
      steering(2, 'activity-steer-1', 'Raw steering input.'),
    ])
    const second = baseTurn(thread, 'turn-2', 2, 'running', 'Raw continuation prompt', [
      toolCall(0, 'call-new', 'write', { intent: 'Write new file' }),
      toolResult(1, 'call-new', 'new-output'),
    ])
    const tasks = yield* inspectWith(thread, [first, second])

    const newest = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      limit: 2,
    })
    assert.strictEqual(newest.activities.length, 2)
    assert.strictEqual(newest.hasMore, true)
    assert.notStrictEqual(newest.nextCursor, null)
    assert.deepStrictEqual(
      newest.activities.map((activity) => activity.kind),
      ['tool', 'progress'],
    )
    if (newest.nextCursor === null) return

    const older = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      cursor: newest.nextCursor,
      limit: 5,
    })
    assert.strictEqual(older.hasMore, false)
    assert.strictEqual(older.nextCursor, null)
    assert.include(
      older.activities.map((activity) => activity.kind),
      'steering',
    )
    assert.include(
      older.activities.map((activity) => activity.kind),
      'tool',
    )
  }),
)

it.effect('keeps a cursor stable when activity and a continuation arrive between pages', () =>
  Effect.gen(function* () {
    const thread = taskThread()
    const initialActivities: Array<Activity> = []
    for (let index = 0; index < 4; index += 1) {
      initialActivities.push(
        toolCall(index * 2, `old-${index}`, `old-${index}`, { intent: 'safe' }),
      )
      initialActivities.push(toolResult(index * 2 + 1, `old-${index}`, 'safe'))
    }
    const firstTurn = baseTurn(thread, 'turn-1', 1, 'running', 'Raw task prompt', initialActivities)
    const continuation = baseTurn(thread, 'turn-2', 2, 'running', 'Raw continuation prompt', [
      toolCall(0, 'continuation', 'continuation', { intent: 'safe' }),
      toolResult(1, 'continuation', 'safe'),
    ])
    const turns = [firstTurn]
    const tasks = yield* inspectWith(thread, turns)

    const firstPage = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      limit: 2,
    })
    assert.deepStrictEqual(
      firstPage.activities.map((activity) => (activity.kind === 'tool' ? activity.toolName : '')),
      ['old-3', 'old-2'],
    )
    if (firstPage.nextCursor === null) return

    turns[0] = {
      ...firstTurn,
      activities: [
        ...initialActivities,
        toolCall(8, 'new-activity', 'new-activity', { intent: 'safe' }),
        toolResult(9, 'new-activity', 'safe'),
      ],
    }
    turns.push(continuation)

    const secondPage = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      cursor: firstPage.nextCursor,
      limit: 20,
    })
    assert.deepStrictEqual(
      secondPage.activities.map((activity) => (activity.kind === 'tool' ? activity.toolName : '')),
      ['old-1', 'old-0'],
    )
    assert.strictEqual(secondPage.hasMore, false)
    assert.strictEqual(secondPage.nextCursor, null)
  }),
)

it.effect('rejects malformed and foreign cursors without leaking existence', () =>
  Effect.gen(function* () {
    const thread = taskThread()
    const turn = baseTurn(thread, 'turn-1', 1, 'running', 'Raw task prompt', [
      toolCall(0, 'call-1', 'read', { intent: 'Read it' }),
      toolResult(1, 'call-1', 'out'),
    ])
    const tasks = yield* inspectWith(thread, [turn])

    const malformed = yield* Effect.flip(
      tasks.inspect({
        parentThreadId: parent.id,
        taskId: decodeTaskId(thread.id),
        cursor: decodeCursor('not-a-valid-cursor'),
      }),
    )
    assert.strictEqual(malformed._tag, 'TaskError')
    if (malformed._tag === 'TaskError') assert.strictEqual(malformed.reason, 'invalid-cursor')

    const foreignCursor = encodeInspectCursor(
      decodeTaskId('task-other'),
      [{ turnSequence: 1, maxActivitySequence: 1, hasLifecycle: false }],
      { turnSequence: 1, sequence: 0, kind: 'activity' },
    )
    const bound = yield* Effect.flip(
      tasks.inspect({
        parentThreadId: parent.id,
        taskId: decodeTaskId(thread.id),
        cursor: foreignCursor,
      }),
    )
    assert.strictEqual(bound._tag, 'TaskError')
    if (bound._tag === 'TaskError') assert.strictEqual(bound.reason, 'invalid-cursor')
  }),
)

it.effect('pairs tool calls and reports active, successful, and failed results safely', () =>
  Effect.gen(function* () {
    const thread = taskThread()
    const turn = baseTurn(thread, 'turn-1', 1, 'running', 'Raw task prompt', [
      toolCall(0, 'call-failed', 'read', { secret: 'raw-args' }),
      toolResult(1, 'call-failed', { secret: 'raw-result' }, 'completed', true),
      toolCall(2, 'call-success', 'bash', { command: 'ls' }),
      toolResult(3, 'call-success', 'listing'),
      toolCall(4, 'call-active', 'grep', { pattern: 'todo' }),
      toolResult(5, 'call-active', null, 'active'),
    ])
    const tasks = yield* inspectWith(thread, [turn])

    const result = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
      limit: 5,
    })
    const tools = result.activities.filter((activity) => activity.kind === 'tool')
    assert.strictEqual(tools.length, 3)
    assert.include(
      tools.map((activity) => activity.status),
      'failed',
    )
    assert.include(
      tools.map((activity) => activity.status),
      'completed',
    )
    assert.include(
      tools.map((activity) => activity.status),
      'active',
    )
    assert.include(
      tools.map((activity) => activity.summary),
      'Ran read',
    )
    assert.include(
      tools.map((activity) => activity.summary),
      'Ran bash',
    )
    const text = JSON.stringify(result)
    assert.notInclude(text, 'raw-args')
    assert.notInclude(text, 'raw-result')
  }),
)

it.effect('uses live pool observation rather than persisted session metadata', () =>
  Effect.gen(function* () {
    const activeThread = taskThread({ harnessSession: null })
    const activeTurn = baseTurn(activeThread, 'turn-active', 1, 'running', 'Raw task prompt')
    const persistedOnlyThread = taskThread({
      id: 'task-persisted-session',
      harnessSession: { id: 'session-1', resumeCursor: { sessionId: 'session-1' } },
    })
    const persistedOnlyTurn = baseTurn(
      persistedOnlyThread,
      'turn-persisted-session',
      1,
      'running',
      'Raw task prompt',
    )

    const absent = yield* inspectWith(activeThread, [activeTurn])
    const absentResult = yield* absent.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(activeThread.id),
    })
    assert.strictEqual(absentResult.outline.runtimePresent, false)
    assert.strictEqual(absentResult.outline.activeTurns, 0)
    assert.strictEqual(absentResult.outline.warnings.length > 0, true)

    const persistedOnly = yield* inspectWith(persistedOnlyThread, [persistedOnlyTurn])
    const persistedOnlyResult = yield* persistedOnly.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(persistedOnlyThread.id),
    })
    assert.strictEqual(persistedOnlyResult.outline.runtimePresent, false)

    const observed = yield* inspectWith(activeThread, [activeTurn], {
      runtimePresent: true,
      activeTurns: 1,
    })
    const observedResult = yield* observed.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(activeThread.id),
    })
    assert.strictEqual(observedResult.outline.runtimePresent, true)
    assert.strictEqual(observedResult.outline.activeTurns, 1)
    assert.strictEqual(observedResult.outline.warnings.length, 0)
  }),
)

it.effect('warns when persisted thread and turn state disagree', () =>
  Effect.gen(function* () {
    const thread = taskThread({ id: 'task-closed', status: 'closed' })
    const turn = baseTurn(thread, 'turn-closed', 1, 'running', 'Raw task prompt')
    const tasks = yield* inspectWith(thread, [turn])
    const result = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
    })
    assert.strictEqual(
      result.outline.warnings.some((warning) => warning.includes('closed')),
      true,
    )
  }),
)

it.effect('isolates tasks by channel without leaking existence', () =>
  Effect.gen(function* () {
    const thread = taskThread()
    const turn = baseTurn(thread, 'turn-1', 1, 'running', 'Raw task prompt')
    const otherParent = decodeChannelThread({ ...parent, id: 'thread-other-parent' })
    const persistence: ThreadPersistenceContract = {
      ...stubPersistence(thread, [turn]),
      getThread: (threadId) =>
        Effect.succeed(
          threadId === parent.id
            ? Option.some(parent)
            : threadId === otherParent.id
              ? Option.some(otherParent)
              : threadId === thread.id
                ? Option.some(thread)
                : Option.none(),
        ),
    }
    const fileSystem = yield* FileSystem.FileSystem
    const tasks = makeTasks({
      persistence,
      friday: readOnlyFriday({ runtimePresent: false, activeTurns: 0 }),
      models: makeTaskModels(() => []),
      channelTurns: noChannelTurns,
      fileSystem,
      randomUUID: Effect.succeed('unused'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: () => Effect.void,
    })

    const foreign = yield* Effect.flip(
      tasks.inspect({ parentThreadId: otherParent.id, taskId: decodeTaskId(thread.id) }),
    )
    assert.strictEqual(foreign._tag, 'TaskError')
    if (foreign._tag === 'TaskError') assert.strictEqual(foreign.reason, 'task-not-found')

    const missing = yield* Effect.flip(
      tasks.inspect({ parentThreadId: parent.id, taskId: decodeTaskId('task-missing') }),
    )
    assert.strictEqual(missing._tag, 'TaskError')
    if (missing._tag === 'TaskError') assert.strictEqual(missing.reason, 'task-not-found')
  }).pipe(Effect.provide(NodeFileSystem.layer)),
)

it.effect('never exposes raw prompts, results, paths, sessions, or logs', () =>
  Effect.gen(function* () {
    const rawPrompt = `Inspect the repository. ${'detail '.repeat(50)}Secret prompt content.`
    const thread = taskThread({ workingDirectory: '/workspace/channel/project' })
    const turn = baseTurn(thread, 'turn-1', 1, 'failed', rawPrompt, [
      toolCall(0, 'call-1', 'read', { password: 'hunter2' }),
      toolResult(1, 'call-1', { token: 'secret-result' }),
      commentary(2, 'activity-commentary-1'),
    ])
    const failedTurn: Turn = {
      ...turn,
      agentMessage: 'Raw assistant text.',
      errorMessage: 'Raw error with secret.',
    }
    const tasks = yield* inspectWith(thread, [failedTurn])

    const result = yield* tasks.inspect({
      parentThreadId: parent.id,
      taskId: decodeTaskId(thread.id),
    })
    const text = JSON.stringify(result)
    assert.notInclude(text, '/workspace/channel/project')
    assert.notInclude(text, 'hunter2')
    assert.notInclude(text, 'secret-result')
    assert.notInclude(text, 'Raw assistant text.')
    assert.notInclude(text, 'Raw error with secret.')
    assert.notInclude(text, 'Secret prompt content.')
    assert.notInclude(text, 'harnessSession')
    assert.strictEqual(result.outline.workspacePath, 'project')
    assert.strictEqual('task' in result.outline, false)
    assert.strictEqual('objective' in result.outline, false)
    assert.strictEqual('prompt' in result.outline, false)
  }),
)

it('resolves workspace paths without absolute leakage', () => {
  assert.strictEqual(relativeWorkspacePath('/workspace/channel', '/workspace/channel'), '.')
  assert.strictEqual(
    relativeWorkspacePath('/workspace/channel', '/workspace/channel/project'),
    'project',
  )
})

it('binds opaque cursors to one task and snapshot boundary', () => {
  const taskId = decodeTaskId('task-owned')
  const boundary = [{ turnSequence: 1, maxActivitySequence: 4, hasLifecycle: false }]
  const cursor = encodeInspectCursor(taskId, boundary, {
    turnSequence: 1,
    sequence: 2,
    kind: 'activity',
  })
  assert.deepStrictEqual(Option.getOrUndefined(decodeInspectCursor(cursor, taskId)), {
    boundary,
    after: { turnSequence: 1, sequence: 2, kind: 'activity' },
  })
  assert.strictEqual(Option.isNone(decodeInspectCursor(cursor, decodeTaskId('task-other'))), true)
  assert.strictEqual(Option.isNone(decodeInspectCursor(decodeCursor('bad-cursor'), taskId)), true)
})

it('orders paired tools newest-first and keeps lifecycle summaries safe', () => {
  const thread = taskThread()
  const first = baseTurn(thread, 'turn-1', 1, 'completed', 'Raw task prompt', [
    toolCall(0, 'call-1', 'read', { intent: 'First read' }),
    toolResult(1, 'call-1', 'out'),
  ])
  const second = baseTurn(thread, 'turn-2', 2, 'running', 'Raw continuation prompt', [
    toolCall(0, 'call-2', 'write', { unrelated: true }),
    toolResult(1, 'call-2', 'out'),
  ])
  const activities = buildTaskActivities([first, second])
  assert.strictEqual(activities[0]?.kind, 'tool')
  if (activities[0]?.kind === 'tool') assert.strictEqual(activities[0].turnSequence, 2)
  const outline = buildTaskOutline({
    taskId: decodeTaskId(thread.id),
    thread,
    parent,
    latestTurn: second,
    runtime: { runtimePresent: false, activeTurns: 0 },
  })
  assert.strictEqual(outline.status, 'running')
  assert.notInclude(JSON.stringify(activities), 'Raw assistant text that must never surface.')
})
