/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide, effecttsgo/async-function -- This focused test drives the task service and Pi tool at their Effect/Promise boundaries. */

import { assert, it } from '@effect/vitest'
import {
  ChannelThread,
  IsoDateTime,
  ModelSelection,
  SubagentProfileName,
  TaskId,
  ThreadId,
  Turn,
  TurnId,
  WorkingDirectory,
  type Thread,
  type Turn as TurnType,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'

import type { FridayContract } from '../Friday.ts'
import type { ChannelTurnsContract } from '../conversation/ChannelTurns.ts'
import { harnessReloadSucceeded } from '../conversation/ThreadRuntime.ts'
import type { ThreadPersistenceContract } from '../conversation/ThreadPersistence.ts'
import { makePiTaskTool } from './PiTaskTool.ts'
import { makeTaskModels } from './TaskModels.ts'
import { makeTasks } from './Tasks.ts'

const decodeChannelThread = Schema.decodeSync(ChannelThread)
const decodeIsoDateTime = Schema.decodeSync(IsoDateTime)
const decodeModel = Schema.decodeSync(ModelSelection)
const decodeProfileName = Schema.decodeSync(SubagentProfileName)
const decodeTaskId = Schema.decodeSync(TaskId)
const decodeTurn = Schema.decodeSync(Turn)
const decodeThreadId = Schema.decodeSync(ThreadId)
const decodeTurnId = Schema.decodeSync(TurnId)
const decodeWorkingDirectory = Schema.decodeSync(WorkingDirectory)

const rootUserIdentities = [
  'discord',
  'guild-root-user-scope',
  'root-user-one',
  'other-guild-scope',
  'root-user-two',
  'slack',
  'workspace-root-user-scope',
  'workspace-user-one',
]

// Distinctive channel-only identity text that must never reach task surfaces.
const identitySentinel = 'Custom identity sentinel Your name is Custom Friday {{channelName}}'

const parent = decodeChannelThread({
  id: 'thread-root-user-task-surface-parent',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'root-user-task-surface', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord-connection',
    channelId: 'discord:guild-root-user-scope:channel-root-user-scope',
    sourceMessageId: 'message-root-user-task-surface',
    conversationId:
      'discord:guild-root-user-scope:channel-root-user-scope:thread-root-user-task-surface',
    scopeId: 'guild-root-user-scope',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const profile = {
  name: decodeProfileName('primary'),
  description: 'General delegated work.',
  model: decodeModel({ provider: 'opencode-go', modelId: 'deepseek-v4-flash' }),
  thinkingLevel: 'max' as const,
}

it.effect('keeps root-user identities out of every normal task content surface', () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const createdThreads: Array<Thread> = []
    const persistedTurns: Array<TurnType> = []
    const promptedTurns: Array<TurnType> = []
    const activityLabels: Array<string | undefined> = []
    const identifiers = [
      'root-user-surface-task',
      'root-user-surface-turn',
      'root-user-surface-continuation',
    ]
    let taskIsTerminal = false
    let promptCount = 0
    let forkCount = 0

    const taskThreadId = decodeThreadId('task-root-user-surface-task')
    const taskId = decodeTaskId('task-root-user-surface-task')
    const taskTurns = () => persistedTurns.filter((turn) => turn.threadId === taskThreadId)
    const persistence: ThreadPersistenceContract = {
      createThread: (thread) =>
        Effect.sync(() => {
          createdThreads.push(thread)
        }),
      getThread: (threadId) => {
        if (threadId === parent.id) return Effect.succeed(Option.some(parent))
        const task = createdThreads.find(
          (thread): thread is Extract<Thread, { audience: 'agent' }> =>
            thread.audience === 'agent' && thread.id === threadId,
        )
        return Effect.succeed(Option.fromNullishOr(task))
      },
      findPlatformThread: () => Effect.succeedNone,
      listAgentThreads: ({ parentThreadId }) =>
        Effect.succeed(
          createdThreads.filter(
            (thread): thread is Extract<Thread, { audience: 'agent' }> =>
              thread.audience === 'agent' && thread.parent.threadId === parentThreadId,
          ),
        ),
      closeThread: () => Effect.void,
      setThreadHarnessSession: () => Effect.void,
      createTurn: (turn) =>
        Effect.sync(() => {
          persistedTurns.push(turn)
        }),
      getTurn: (turnId) =>
        Effect.succeed(Option.fromNullishOr(persistedTurns.find((turn) => turn.id === turnId))),
      getFirstTurn: (threadId) =>
        Effect.succeed(
          Option.fromNullishOr(taskTurns().find((turn) => turn.threadId === threadId)),
        ),
      getLatestTurn: (threadId) => {
        const latest = taskTurns().at(-1)
        if (latest === undefined || latest.threadId !== threadId) return Effect.succeedNone
        return Effect.succeed(
          taskIsTerminal
            ? Option.some(
                decodeTurn({
                  ...latest,
                  status: 'completed',
                  completedAt: '2026-03-21T10:01:00.000Z',
                }),
              )
            : Option.some(latest),
        )
      },
      getLatestUserTurn: () => Effect.succeedNone,
      startTurn: () => Effect.void,
      putActivitySnapshot: () => Effect.void,
      getActivity: () => Effect.succeedNone,
      completeTurn: () => Effect.void,
      interruptTurn: () => Effect.void,
      failTurn: () => Effect.void,
    }

    const friday: FridayContract = {
      openThread: () =>
        Effect.succeed({
          prompt: (turn) =>
            Effect.gen(function* () {
              promptCount += 1
              promptedTurns.push(turn)
              yield* persistence.createTurn(turn)
              const awaitTerminal =
                promptCount === 1
                  ? Effect.succeed({
                      status: 'completed' as const,
                      turnId: turn.id,
                      agentMessage: 'done',
                      usage: null,
                    })
                  : Effect.never
              return { turnId: turn.id, awaitTerminal }
            }),
          steer: () => Effect.void,
          cancel: () => Effect.void,
          reload: () => Effect.succeed(harnessReloadSucceeded()),
          onEvent: () => Effect.void,
          start: Effect.void,
          drain: Effect.never,
        }),
    }
    const conversationTitles = {
      generated: () => Effect.void,
      taskStarted: (_thread: typeof parent, _taskId: typeof taskId, task?: string) =>
        Effect.sync(() => {
          activityLabels.push(task)
        }),
      taskFinished: () => Effect.void,
    }
    const channelTurns: ChannelTurnsContract = { accept: () => Effect.void }
    const tasks = makeTasks({
      persistence,
      friday,
      models: makeTaskModels(() => [profile]),
      channelTurns,
      conversationTitles,
      fileSystem,
      randomUUID: Effect.sync(() => identifiers.shift() ?? 'unexpected-identifier'),
      now: Effect.succeed(decodeIsoDateTime('2026-03-21T10:00:00.000Z')),
      fork: (effect) => {
        forkCount += 1
        return forkCount === 1 ? effect : effect.pipe(Effect.forkChild, Effect.asVoid)
      },
    })

    const taskText = 'Inspect the repository and report the result.'
    const started = yield* tasks.start({
      parentThreadId: parent.id,
      parentTurnId: decodeTurnId('turn-root-user-task-surface-parent'),
      task: taskText,
      workingDirectory: decodeWorkingDirectory('/tmp'),
    })

    assert.strictEqual(started.taskId, taskId)
    assert.lengthOf(promptedTurns, 1)
    assert.lengthOf(persistedTurns, 1)
    assert.strictEqual(persistedTurns[0]?.input.content.text, taskText)

    const listed = yield* tasks.list({ parentThreadId: parent.id, status: 'all' })
    assert.lengthOf(listed, 1)
    assert.strictEqual(listed[0]?.task, taskText)

    const taskTool = makePiTaskTool({
      thread: parent,
      tasks: {
        start: () => Effect.die('not used'),
        bootstrap: () => Effect.die('not used'),
        steer: () => Effect.die('not used'),
        list: () => Effect.succeed(listed),
        cancel: () => Effect.die('not used'),
      },
      activeTurnId: () => decodeTurnId('turn-root-user-task-surface-parent'),
      runPromise: Effect.runPromise,
    })
    const toolResult = yield* Effect.promise(() =>
      // SAFETY: Pi's SDK context is unused by this tool operation.
      taskTool.execute(
        'root-user-surface-list',
        { action: 'list' },
        undefined,
        undefined,
        {} as never,
      ),
    )
    const toolText = toolResult.content
      .flatMap((entry) => (entry.type === 'text' ? [entry.text] : []))
      .join('\n')
    assert.include(toolText, taskText)

    taskIsTerminal = true
    const continuationText = 'Continue by checking the focused test output.'
    yield* tasks.steer({
      parentThreadId: parent.id,
      taskId,
      message: continuationText,
    })

    assert.lengthOf(promptedTurns, 2)
    assert.strictEqual(promptedTurns[1]?.input.content.text, continuationText)
    assert.deepStrictEqual(activityLabels, [taskText, taskText])

    for (const text of [
      ...persistedTurns.map((turn) => turn.input.content.text),
      ...listed.map((summary) => summary.task),
      ...activityLabels.filter((label): label is string => label !== undefined),
      toolText,
      continuationText,
    ]) {
      for (const rootUserIdentity of rootUserIdentities) {
        assert.notInclude(text, rootUserIdentity)
      }
      assert.notInclude(text, identitySentinel)
      assert.notInclude(text, 'Your name is Custom Friday')
    }
  }).pipe(Effect.provide(NodeFileSystem.layer)),
)
