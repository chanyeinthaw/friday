import { assert, it } from '@effect/vitest'
import { ChannelThread, PlatformConnectionId, TaskId } from '@friday/contracts/conversation'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { ConversationTitles, ConversationTitlesLive } from './ConversationTitles.ts'
import type { PlatformAdapter } from './PlatformAdapter.ts'
import { PlatformRegistry, PlatformRegistryLive } from './PlatformRegistry.ts'

const taskId = Schema.decodeSync(TaskId)('task-title')
const decodeThread = Schema.decodeSync(ChannelThread)
const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const thread = decodeThread({
  id: 'thread-title',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/title',
  model: { provider: 'openai', modelId: 'gpt' },
  thinkingLevel: 'medium',
  channelContext: { name: 'title', description: '' },
  conversationBinding: {
    platform: 'test',
    connectionId: 'test',
    channelId: 'channel-title',
    sourceMessageId: 'message-title',
    conversationId: 'conversation-title',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})
const secondThread = decodeThread({
  ...thread,
  id: 'thread-title-second',
  conversationBinding: {
    ...thread.conversationBinding,
    channelId: 'channel-title-second',
    sourceMessageId: 'message-title-second',
    conversationId: 'conversation-title-second',
  },
})

it.effect('keeps generated titles unchanged and reports platform-wide task counts', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const titles: Array<string> = []
      const activity: Array<{ taskId: string; active: boolean }> = []
      const platform: PlatformAdapter<never> = {
        connectionId: thread.conversationBinding.connectionId,
        kind: 'test',
        publish: () => Effect.void,
        acknowledge: () => Effect.void,
        beginWorking: () => Effect.void,
        updateWorking: () => Effect.void,
        discardWorking: () => Effect.void,
        finalizeWorking: () => Effect.void,
        setConversationTitle: ({ title }) => Effect.sync(() => titles.push(title)),
        setAgentActivity: ({ taskId: activityTaskId, active }) =>
          Effect.sync(() => activity.push({ taskId: activityTaskId, active })),
        searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
        withTyping: (_binding, effect) => effect,
      }
      const registry = yield* PlatformRegistry
      yield* registry.register(platform)
      const conversationTitles = yield* ConversationTitles

      yield* conversationTitles.generated(thread, 'Repository Inspection')
      yield* conversationTitles.taskStarted(thread, taskId)
      yield* conversationTitles.taskStarted(thread, taskId)
      yield* conversationTitles.taskFinished(thread, taskId)
      yield* conversationTitles.taskFinished(thread, taskId)

      assert.deepStrictEqual(titles, ['Repository Inspection'])
      assert.deepStrictEqual(activity, [
        { taskId, active: true },
        { taskId, active: true },
        { taskId, active: false },
        { taskId, active: false },
      ])
    }).pipe(
      Effect.provide(
        Layer.merge(
          PlatformRegistryLive,
          ConversationTitlesLive.pipe(Layer.provide(PlatformRegistryLive)),
        ),
      ),
    ),
  ),
)

it.effect(
  'does not let one hanging conversation block another through ConversationTitlesLive',
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hangingStarted = yield* Deferred.make<void>()
        const releaseHanging = yield* Deferred.make<void>()
        const activity: Array<string> = []
        const platform: PlatformAdapter<never> = {
          connectionId: thread.conversationBinding.connectionId,
          kind: 'test',
          publish: () => Effect.void,
          acknowledge: () => Effect.void,
          beginWorking: () => Effect.void,
          updateWorking: () => Effect.void,
          discardWorking: () => Effect.void,
          finalizeWorking: () => Effect.void,
          setConversationTitle: () => Effect.void,
          setAgentActivity: ({ binding, active }) =>
            binding.conversationId === thread.conversationBinding.conversationId
              ? Deferred.succeed(hangingStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseHanging)),
                )
              : Effect.sync(() => activity.push(`${binding.conversationId}:${String(active)}`)),
          searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
          withTyping: (_binding, effect) => effect,
        }
        const registry = yield* PlatformRegistry
        yield* registry.register(platform)
        const conversationTitles = yield* ConversationTitles

        const hanging = yield* conversationTitles.taskStarted(thread, taskId).pipe(Effect.forkChild)
        yield* Deferred.await(hangingStarted)
        yield* conversationTitles.taskStarted(secondThread, taskId)
        yield* conversationTitles.taskFinished(secondThread, taskId)

        assert.deepStrictEqual(activity, [
          'conversation-title-second:true',
          'conversation-title-second:false',
        ])
        yield* Deferred.succeed(releaseHanging, undefined)
        yield* Fiber.join(hanging)
      }).pipe(
        Effect.provide(
          Layer.merge(
            PlatformRegistryLive,
            ConversationTitlesLive.pipe(Layer.provide(PlatformRegistryLive)),
          ),
        ),
      ),
    ),
)

// Guards against concatenated-key collisions: ('a', 'b:c') and ('a:b', 'c')
// previously produced the same "a:b:c" key and wrongly serialized together.
it.effect('does not collide on joined keys where (a, b:c) differs from (a:b, c)', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const collisionThread = decodeThread({
        ...thread,
        id: 'thread-collision-joined',
        conversationBinding: {
          ...thread.conversationBinding,
          channelId: 'channel-collision-joined',
          sourceMessageId: 'message-collision-joined',
          connectionId: 'a',
          conversationId: 'b:c',
        },
      })
      const collidingThread = decodeThread({
        ...thread,
        id: 'thread-colliding',
        conversationBinding: {
          ...thread.conversationBinding,
          channelId: 'channel-colliding',
          sourceMessageId: 'message-colliding',
          connectionId: 'a:b',
          conversationId: 'c',
        },
      })

      const joinedStarted = yield* Deferred.make<void>()
      const releaseJoined = yield* Deferred.make<void>()
      const activity: Array<string> = []
      const makePlatform = (connectionId: PlatformConnectionId): PlatformAdapter<never> => ({
        connectionId,
        kind: 'test',
        publish: () => Effect.void,
        acknowledge: () => Effect.void,
        beginWorking: () => Effect.void,
        updateWorking: () => Effect.void,
        discardWorking: () => Effect.void,
        finalizeWorking: () => Effect.void,
        setConversationTitle: () => Effect.void,
        setAgentActivity: ({ binding, active }) =>
          binding.connectionId === 'a' && binding.conversationId === 'b:c'
            ? Deferred.succeed(joinedStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseJoined)),
              )
            : Effect.sync(() =>
                activity.push(
                  `${binding.connectionId}:${binding.conversationId}:${String(active)}`,
                ),
              ),
        searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
        withTyping: (_binding, effect) => effect,
      })
      const registry = yield* PlatformRegistry
      yield* registry.register(makePlatform(decodeConnectionId('a')))
      yield* registry.register(makePlatform(decodeConnectionId('a:b')))
      const conversationTitles = yield* ConversationTitles

      const hanging = yield* conversationTitles
        .taskStarted(collisionThread, taskId)
        .pipe(Effect.forkChild)
      yield* Deferred.await(joinedStarted)
      yield* conversationTitles.taskStarted(collidingThread, taskId)
      yield* conversationTitles.taskFinished(collidingThread, taskId)

      assert.deepStrictEqual(activity, ['a:b:c:true', 'a:b:c:false'])
      yield* Deferred.succeed(releaseJoined, undefined)
      yield* Fiber.join(hanging)
    }).pipe(
      Effect.provide(
        Layer.merge(
          PlatformRegistryLive,
          ConversationTitlesLive.pipe(Layer.provide(PlatformRegistryLive)),
        ),
      ),
    ),
  ),
)
