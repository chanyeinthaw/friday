import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Logger from 'effect/Logger'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { TestClock } from 'effect/testing'

import type { PlatformAgentActivity } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import {
  findDuplicateDiscordApplications,
  makeDiscordAgentActivity,
  type DiscordPresence,
  type DiscordPresenceGateway,
} from './DiscordAgentActivity.ts'

it('detects duplicate Discord application IDs and reports only connection IDs', () => {
  assert.deepStrictEqual(
    findDuplicateDiscordApplications([
      { connectionId: 'discord-a', applicationId: 'app-1', botToken: 'token-a' },
      { connectionId: 'discord-b', applicationId: 'app-1', botToken: 'token-b' },
      { connectionId: 'discord-c', applicationId: 'app-2', botToken: 'token-c' },
    ]),
    [['discord-a', 'discord-b']],
  )
})

it('detects duplicate Discord bot tokens and reports only connection IDs', () => {
  assert.deepStrictEqual(
    findDuplicateDiscordApplications([
      { connectionId: 'discord-a', applicationId: 'app-1', botToken: 'shared-secret' },
      { connectionId: 'discord-b', applicationId: 'app-2', botToken: 'shared-secret' },
      { connectionId: 'discord-c', applicationId: 'app-3', botToken: 'other-secret' },
    ]),
    [['discord-a', 'discord-b']],
  )
})

const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord-test',
  channelId: 'channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'channel-1',
})

const activityInput = (taskId: string, active: boolean): PlatformAgentActivity =>
  active
    ? { binding, taskId, active, task: `SECRET CONTENT ${taskId}` }
    : { binding, taskId, active }

const makeFakeGateway = () => {
  const calls: Array<DiscordPresence> = []
  let failuresLeft = 0
  let failAll = false
  const gateway: DiscordPresenceGateway = {
    setPresence: (presence) =>
      Effect.gen(function* () {
        calls.push(presence)
        if (failAll || failuresLeft > 0) {
          if (failuresLeft > 0) failuresLeft -= 1
          return yield* Effect.fail(
            new ChatSdkPublicationError({
              operation: 'set-agent-activity',
              cause: new Error('presence update failed'),
            }),
          )
        }
      }),
  }
  return {
    calls,
    gateway,
    failNext: (count: number): void => {
      failuresLeft = count
    },
    setFailAll: (fail: boolean): void => {
      failAll = fail
    },
  }
}

it.effect('shows idle with a singular count while one task runs, online when it ends', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      assert.deepStrictEqual(fake.calls, [
        { status: 'idle', activity: 'Working on 1 task', activeTaskCount: 1 },
      ])

      yield* activity.setAgentActivity(activityInput('task-1', false))
      yield* Effect.yieldNow
      assert.deepStrictEqual(fake.calls, [
        { status: 'idle', activity: 'Working on 1 task', activeTaskCount: 1 },
        { status: 'online', activity: undefined, activeTaskCount: 0 },
      ])
      assert.notMatch(JSON.stringify(fake.calls), /SECRET/u)
    }),
  ),
)

it.effect('aggregates concurrent tasks and skips updates when the count is unchanged', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      yield* activity.setAgentActivity(activityInput('task-2', true))
      yield* Effect.yieldNow
      assert.deepStrictEqual(
        fake.calls.map((call) => call.activity),
        ['Working on 1 task', 'Working on 2 tasks'],
      )

      // Finishing an unknown task changes nothing, so no update goes out.
      yield* activity.setAgentActivity(activityInput('task-9', false))
      yield* Effect.yieldNow
      // Re-starting an already active task keeps the same count, also silent.
      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 2)

      yield* activity.setAgentActivity(activityInput('task-1', false))
      yield* Effect.yieldNow
      assert.deepStrictEqual(
        fake.calls.map((call) => call.activity),
        ['Working on 1 task', 'Working on 2 tasks', 'Working on 1 task'],
      )
      assert.notMatch(JSON.stringify(fake.calls), /SECRET/u)
    }),
  ),
)

it.effect('retries failed updates with backoff until one succeeds', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      fake.failNext(2)
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 1)

      yield* TestClock.adjust('1 second')
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 2)

      yield* TestClock.adjust('2 seconds')
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 3)
      assert.deepStrictEqual(fake.calls[2], {
        status: 'idle',
        activity: 'Working on 1 task',
        activeTaskCount: 1,
      })

      // The success counts as applied, so ending the task updates once more.
      yield* activity.setAgentActivity(activityInput('task-1', false))
      yield* Effect.yieldNow
      assert.deepStrictEqual(fake.calls[3], {
        status: 'online',
        activity: undefined,
        activeTaskCount: 0,
      })
      assert.strictEqual(fake.calls.length, 4)
    }),
  ),
)

it.effect('stops after five attempts and logs one structured error', () => {
  const logs: Array<{
    message: unknown
    annotations: {
      readonly status?: unknown
      readonly activeTaskCount?: unknown
      readonly attempts?: unknown
      readonly errorTag?: unknown
      readonly operation?: unknown
    }
  }> = []
  const captureLogger = Logger.map(Logger.formatStructured, (output) => {
    logs.push({ message: output.message, annotations: output.annotations })
  })
  return Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      fake.setFailAll(true)
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 1)

      // Backoff delays total 1 + 2 + 4 + 8 seconds for attempts two to five.
      yield* TestClock.adjust('15 seconds')
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 5)

      // Exhaustion ends the loop. No sixth attempt follows.
      yield* TestClock.adjust('1 minute')
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 5)

      const failures = logs.filter((log) => log.message === 'discord.presence.update-failed')
      assert.strictEqual(failures.length, 1)
      assert.strictEqual(failures[0]?.annotations.status, 'idle')
      assert.strictEqual(failures[0]?.annotations.activeTaskCount, 1)
      assert.strictEqual(failures[0]?.annotations.attempts, 5)
      assert.notMatch(JSON.stringify(logs), /SECRET/u)
    }),
  ).pipe(Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: true })))
})

it.effect('attempts normally again after exhaustion when the state changes', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      fake.setFailAll(true)
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      yield* TestClock.adjust('16 seconds')
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 5)

      // The exhausted state was never cached as applied, so a new count
      // attempts right away once the gateway recovers.
      fake.setFailAll(false)
      yield* activity.setAgentActivity(activityInput('task-2', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 6)
      assert.deepStrictEqual(fake.calls[5], {
        status: 'idle',
        activity: 'Working on 2 tasks',
        activeTaskCount: 2,
      })

      yield* activity.setAgentActivity(activityInput('task-1', false))
      yield* Effect.yieldNow
      yield* activity.setAgentActivity(activityInput('task-2', false))
      yield* Effect.yieldNow
      assert.deepStrictEqual(fake.calls[6], {
        status: 'idle',
        activity: 'Working on 1 task',
        activeTaskCount: 1,
      })
      assert.deepStrictEqual(fake.calls[7], {
        status: 'online',
        activity: undefined,
        activeTaskCount: 0,
      })
      assert.strictEqual(fake.calls.length, 8)
    }),
  ),
)

it.effect('supersedes in-flight retries so newer states win', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      fake.failNext(100)
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 1)

      // A second task starts during backoff. The older loop must not write again.
      yield* activity.setAgentActivity(activityInput('task-2', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 2)

      yield* TestClock.adjust('16 seconds')
      yield* Effect.yieldNow
      assert.deepStrictEqual(
        fake.calls.map((call) => call.activity),
        [
          'Working on 1 task',
          'Working on 2 tasks',
          'Working on 2 tasks',
          'Working on 2 tasks',
          'Working on 2 tasks',
          'Working on 2 tasks',
        ],
      )
    }),
  ),
)

it.effect('resyncs through the shared pipeline so reconnects converge with retry', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 1)

      // Gateway (re)connects lose server-side presence, so resync forces a
      // write even though the derived key already matches the last applied one.
      yield* activity.resyncPresence()
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 2)
      assert.deepStrictEqual(fake.calls[1], {
        status: 'idle',
        activity: 'Working on 1 task',
        activeTaskCount: 1,
      })
      assert.notMatch(JSON.stringify(fake.calls), /SECRET/u)
    }),
  ),
)

it.effect('retries resyncs with the same backoff and safe exhaustion log', () => {
  const logs: Array<{
    message: unknown
    annotations: {
      readonly status?: unknown
      readonly activeTaskCount?: unknown
      readonly attempts?: unknown
      readonly errorTag?: unknown
      readonly operation?: unknown
    }
  }> = []
  const captureLogger = Logger.map(Logger.formatStructured, (output) => {
    logs.push({ message: output.message, annotations: output.annotations })
    return output
  })
  return Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      fake.setFailAll(true)
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.resyncPresence()
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 1)

      yield* TestClock.adjust('15 seconds')
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 5)

      yield* TestClock.adjust('1 minute')
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 5)

      const failures = logs.filter((log) => log.message === 'discord.presence.update-failed')
      assert.strictEqual(failures.length, 1)
      assert.strictEqual(failures[0]?.annotations.status, 'online')
      assert.strictEqual(failures[0]?.annotations.activeTaskCount, 0)
      assert.strictEqual(failures[0]?.annotations.attempts, 5)
      assert.strictEqual(failures[0]?.annotations.errorTag, 'ChatSdkPublicationError')
      assert.strictEqual(failures[0]?.annotations.operation, 'set-agent-activity')
      assert.notMatch(JSON.stringify(logs), /SECRET/u)
    }),
  ).pipe(Effect.provide(Logger.layer([captureLogger], { mergeWithExisting: true })))
})

it.effect('lets newer task states win over an in-flight resync', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      const activity = yield* makeDiscordAgentActivity(fake.gateway)

      yield* activity.setAgentActivity(activityInput('task-1', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 1)

      // The resync forces a second write even though the key matches, then
      // fails into backoff; a newer task transition supersedes it.
      fake.failNext(100)
      yield* activity.resyncPresence()
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 2)

      // A newer task transition during resync backoff supersedes it.
      yield* activity.setAgentActivity(activityInput('task-2', true))
      yield* Effect.yieldNow
      assert.strictEqual(fake.calls.length, 3)

      yield* TestClock.adjust('16 seconds')
      yield* Effect.yieldNow
      assert.deepStrictEqual(
        fake.calls.map((call) => call.activity),
        [
          'Working on 1 task',
          'Working on 1 task',
          'Working on 2 tasks',
          'Working on 2 tasks',
          'Working on 2 tasks',
          'Working on 2 tasks',
          'Working on 2 tasks',
        ],
      )
    }),
  ),
)

it.effect('restores online presence when the scope closes with tasks active', () =>
  Effect.gen(function* () {
    const fake = makeFakeGateway()
    const scope = yield* Scope.make()
    const activity = yield* makeDiscordAgentActivity(fake.gateway).pipe(
      Effect.provideService(Scope.Scope, scope),
    )

    yield* activity.setAgentActivity(activityInput('task-1', true))
    yield* Effect.yieldNow
    assert.strictEqual(fake.calls.length, 1)

    yield* Scope.close(scope, Exit.void)
    assert.deepStrictEqual(fake.calls, [
      { status: 'idle', activity: 'Working on 1 task', activeTaskCount: 1 },
      { status: 'online', activity: undefined, activeTaskCount: 0 },
    ])
  }),
)

it.effect('skips the shutdown reset when already online', () =>
  Effect.gen(function* () {
    const fake = makeFakeGateway()
    const scope = yield* Scope.make()
    yield* makeDiscordAgentActivity(fake.gateway).pipe(Effect.provideService(Scope.Scope, scope))
    yield* Scope.close(scope, Exit.void)
    assert.deepStrictEqual(fake.calls, [])
  }),
)
