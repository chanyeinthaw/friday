/* oxlint-disable anti-slop/no-unknown-parameters, effecttsgo/async-function -- The Pi tool contract accepts unknown input and is Promise-based. */

import { assert, expect, it } from '@effect/vitest'
import {
  ChannelThread,
  ModelSelection,
  SubagentProfileName,
  TaskId,
  TaskInspectCursor,
  TurnId,
} from '@friday/contracts/conversation'
import { validateToolArguments } from '@earendil-works/pi-ai'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makePiTaskTool } from './PiTaskTool.ts'
import { TaskError, type TasksContract } from './Tasks.ts'

const decodeChannelThread = Schema.decodeSync(ChannelThread)
const decodeModel = Schema.decodeSync(ModelSelection)
const decodeProfileName = Schema.decodeSync(SubagentProfileName)
const decodeTaskId = Schema.decodeSync(TaskId)
const decodeCursor = Schema.decodeSync(TaskInspectCursor)
const decodeTurnId = Schema.decodeSync(TurnId)

const channelThread = decodeChannelThread({
  id: 'thread-task-tool',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/task-tool',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'task-tool', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'channel-task-tool',
    sourceMessageId: 'message-task-tool',
    conversationId: 'conversation-task-tool',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const taskOperations = (calls: Array<unknown>): TasksContract => ({
  start: (request) =>
    Effect.sync(() => calls.push(request)).pipe(
      Effect.as({ taskId: decodeTaskId('task-started'), status: 'pending' as const }),
    ),
  bootstrap: () => Effect.die('not expected'),
  steer: () => Effect.die('not expected'),
  list: () => Effect.die('not expected'),
  cancel: () => Effect.die('not expected'),
  inspect: () => Effect.die('not expected'),
  setModel: () => Effect.die('not expected'),
})

const execute = async (calls: Array<unknown>, input: unknown) => {
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: taskOperations(calls),
    activeTurnId: () => decodeTurnId('turn-active'),
    runPromise: Effect.runPromise,
  })
  // SAFETY: The task tool does not read ExtensionContext for these operations.
  return tool.execute('call-task', input, undefined, undefined, {} as never)
}

it('surfaces task failure details through the Pi tool boundary', async () => {
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: {
      ...taskOperations([]),
      start: () =>
        Effect.fail(
          new TaskError({
            operation: 'start',
            reason: 'working-directory-busy',
            detail: 'The requested directory is busy.',
          }),
        ),
    },
    activeTurnId: () => decodeTurnId('turn-active'),
    runPromise: Effect.runPromise,
  })

  await expect(
    tool.execute(
      'call-task',
      {
        action: 'start',
        task: 'Inspect the project.',
        workingDirectory: '/tmp/project',
        mayWrite: false,
      },
      undefined,
      undefined,
      // SAFETY: The task tool does not read ExtensionContext for this operation.
      {} as never,
    ),
  ).rejects.toThrow('The requested directory is busy.')
})

it('scopes inspect calls to the channel thread and returns the safe outline', async () => {
  const calls: Array<unknown> = []
  const outline = {
    taskId: decodeTaskId('task-owned'),
    role: 'subagent' as const,
    status: 'running' as const,
    workspacePath: 'project',
    mayWrite: false,
    createdAt: '2026-03-21T10:00:00.000Z',
    updatedAt: '2026-03-21T10:00:00.000Z',
    completedAt: null,
    runtimePresent: false,
    activeTurns: 1,
    warnings: ['No live runtime is currently observed; persisted progress may be stale.'],
  }
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: {
      ...taskOperations(calls),
      inspect: (request) =>
        Effect.sync(() => calls.push(request)).pipe(
          Effect.as({
            outline,
            activities: [
              {
                kind: 'tool' as const,
                toolName: 'read',
                summary: 'Read the config',
                status: 'completed' as const,
                isError: false,
                turnSequence: 1,
                createdAt: '2026-03-21T10:01:00.000Z',
                updatedAt: '2026-03-21T10:01:02.000Z',
                completedAt: '2026-03-21T10:01:02.000Z',
              },
            ],
            nextCursor: null,
            hasMore: false,
          }),
        ),
    },
    activeTurnId: () => null,
    runPromise: Effect.runPromise,
  })

  const result = await tool.execute(
    'call-inspect',
    { action: 'inspect', taskId: 'task-owned', limit: 5 },
    undefined,
    undefined,
    // SAFETY: The task tool does not read ExtensionContext for this operation.
    {} as never,
  )
  assert.deepStrictEqual(calls, [
    { parentThreadId: channelThread.id, taskId: decodeTaskId('task-owned'), limit: 5 },
  ])
  const text = String(result?.content[0]?.type === 'text' ? result.content[0].text : '')
  assert.include(text, 'task-owned')
  assert.include(text, 'Read the config')
  assert.notInclude(text, '/tmp/friday')
})

it('passes opaque inspect cursors only for older history', async () => {
  const calls: Array<unknown> = []
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: {
      ...taskOperations(calls),
      inspect: (request) =>
        Effect.sync(() => calls.push(request)).pipe(
          Effect.as({
            outline: {
              taskId: decodeTaskId('task-owned'),
              role: 'subagent' as const,
              status: 'running' as const,
              workspacePath: '.',
              mayWrite: true,
              createdAt: '2026-03-21T10:00:00.000Z',
              updatedAt: '2026-03-21T10:00:00.000Z',
              completedAt: null,
              runtimePresent: false,
              activeTurns: 1,
              warnings: [],
            },
            activities: [],
            nextCursor: null,
            hasMore: false,
          }),
        ),
    },
    activeTurnId: () => decodeTurnId('turn-active'),
    runPromise: Effect.runPromise,
  })

  await tool.execute(
    'call-inspect-cursor',
    { action: 'inspect', taskId: 'task-owned', cursor: 'opaque-cursor', limit: 5 },
    undefined,
    undefined,
    // SAFETY: The task tool does not read ExtensionContext for this operation.
    {} as never,
  )
  assert.deepStrictEqual(calls, [
    {
      parentThreadId: channelThread.id,
      taskId: decodeTaskId('task-owned'),
      cursor: 'opaque-cursor',
      limit: 5,
    },
  ])
})

it('rejects inspect limits above the maximum at the tool boundary', async () => {
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: taskOperations([]),
    activeTurnId: () => decodeTurnId('turn-active'),
    runPromise: Effect.runPromise,
  })

  await expect(
    tool.execute(
      'call-inspect-limit',
      { action: 'inspect', taskId: 'task-owned', limit: 21 },
      undefined,
      undefined,
      // SAFETY: The task tool does not read ExtensionContext for this operation.
      {} as never,
    ),
  ).rejects.toThrow()
})

it('rejects empty inspect identifiers and out-of-range limits at the tool boundary', async () => {
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: taskOperations([]),
    activeTurnId: () => decodeTurnId('turn-active'),
    runPromise: Effect.runPromise,
  })
  const executeInspect = (input: unknown) =>
    tool.execute(
      'call-inspect-constraints',
      input,
      undefined,
      undefined,
      // SAFETY: The task tool does not read ExtensionContext for this operation.
      {} as never,
    )

  await expect(executeInspect({ action: 'inspect', taskId: '  ' })).rejects.toThrow()
  await expect(
    executeInspect({ action: 'inspect', taskId: 'task-owned', cursor: '  ' }),
  ).rejects.toThrow()
  await expect(
    executeInspect({ action: 'inspect', taskId: 'task-owned', limit: 0 }),
  ).rejects.toThrow()
})

it('keeps inspect identifier validation in parity across TypeBox and Effect', () => {
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: taskOperations([]),
    activeTurnId: () => decodeTurnId('turn-active'),
    runPromise: Effect.runPromise,
  })
  const validateInspect = (input: { action: 'inspect'; taskId: string; cursor?: string }) =>
    validateToolArguments(tool, {
      type: 'toolCall',
      id: 'call-inspect-parity',
      name: 'task',
      arguments: input,
    })
  const taskId = 'task\nowned'
  const cursor = 'cursor\r\nopaque'

  expect(validateInspect({ action: 'inspect', taskId, cursor })).toEqual({
    action: 'inspect',
    taskId,
    cursor,
  })
  expect(decodeTaskId(taskId)).toBe(taskId)
  expect(decodeCursor(cursor)).toBe(cursor)

  for (const value of ['', ' ', ' task', 'task ', '\ntask', 'task\n']) {
    expect(() => validateInspect({ action: 'inspect', taskId: value, cursor })).toThrow()
    expect(() => decodeTaskId(value)).toThrow()
    expect(() => validateInspect({ action: 'inspect', taskId, cursor: value })).toThrow()
    expect(() => decodeCursor(value)).toThrow()
  }
})

it('scopes task start calls to the current channel Thread and active Turn', async () => {
  const calls: Array<unknown> = []
  const result = await execute(calls, {
    action: 'start',
    task: 'Inspect the project.',
    workingDirectory: '/tmp/project',
    mayWrite: false,
    profile: 'primary',
  })

  assert.deepStrictEqual(calls, [
    {
      parentThreadId: channelThread.id,
      parentTurnId: decodeTurnId('turn-active'),
      task: 'Inspect the project.',
      workingDirectory: '/tmp/project',
      mayWrite: false,
      profile: 'primary',
    },
  ])
  assert.include(
    String(result?.content[0]?.type === 'text' ? result.content[0].text : ''),
    'task-started',
  )
})

it('scopes set-model calls to the channel thread and passes the configured profile through', async () => {
  const calls: Array<unknown> = []
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: {
      ...taskOperations(calls),
      setModel: (request) =>
        Effect.sync(() => calls.push(request)).pipe(
          Effect.as({
            taskId: request.taskId,
            profile: request.profile,
            model: decodeModel({ provider: 'opencode-go', modelId: 'muse13-free-model' }),
            thinkingLevel: 'low' as const,
          }),
        ),
    },
    activeTurnId: () => null,
    runPromise: Effect.runPromise,
  })

  const result = await tool.execute(
    'call-set-model',
    { action: 'set-model', taskId: 'task-owned', profile: 'muse13-free' },
    undefined,
    undefined,
    // SAFETY: The task tool does not read ExtensionContext for this operation.
    {} as never,
  )

  assert.deepStrictEqual(calls, [
    {
      parentThreadId: channelThread.id,
      taskId: decodeTaskId('task-owned'),
      profile: decodeProfileName('muse13-free'),
    },
  ])
  assert.include(
    String(result?.content[0]?.type === 'text' ? result.content[0].text : ''),
    'muse13-free',
  )
})

it('rejects blank set-model identifiers and profiles at the tool boundary', async () => {
  const tool = makePiTaskTool({
    thread: channelThread,
    tasks: taskOperations([]),
    activeTurnId: () => decodeTurnId('turn-active'),
    runPromise: Effect.runPromise,
  })
  const executeModelSet = (input: unknown) =>
    tool.execute(
      'call-set-model-constraints',
      input,
      undefined,
      undefined,
      // SAFETY: The task tool does not read ExtensionContext for this operation.
      {} as never,
    )

  await expect(
    executeModelSet({ action: 'set-model', taskId: '  ', profile: 'primary' }),
  ).rejects.toThrow()
  await expect(
    executeModelSet({ action: 'set-model', taskId: 'task-owned', profile: '  ' }),
  ).rejects.toThrow()
})
