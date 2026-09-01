/* oxlint-disable anti-slop/no-unknown-parameters, effecttsgo/async-function -- The Pi tool contract accepts unknown input and is Promise-based. */

import { assert, expect, it } from '@effect/vitest'
import { ChannelThread, TaskId, TurnId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makePiTaskTool } from './PiTaskTool.ts'
import { TaskError, type TasksContract } from './Tasks.ts'

const decodeChannelThread = Schema.decodeSync(ChannelThread)
const decodeTaskId = Schema.decodeSync(TaskId)
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
