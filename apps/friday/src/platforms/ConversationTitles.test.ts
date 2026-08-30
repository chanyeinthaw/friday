import { assert, it } from '@effect/vitest'
import { ChannelThread, TaskId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { ConversationTitles, ConversationTitlesLive } from './ConversationTitles.ts'
import type { PlatformAdapter } from './PlatformAdapter.ts'
import { PlatformRegistry, PlatformRegistryLive } from './PlatformRegistry.ts'

const taskId = Schema.decodeSync(TaskId)('task-title')
const thread = Schema.decodeSync(ChannelThread)({
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
    channelId: 'channel-title',
    sourceMessageId: 'message-title',
    conversationId: 'conversation-title',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

it.effect('keeps generated titles unchanged and reports platform-wide task counts', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const titles: Array<string> = []
      const activity: Array<{ taskId: string; active: boolean }> = []
      const platform: PlatformAdapter<never> = {
        kind: 'test',
        publish: () => Effect.void,
        acknowledge: () => Effect.void,
        beginWorking: () => Effect.void,
        updateWorking: () => Effect.void,
        discardWorking: () => Effect.void,
        finalizeWorking: () => Effect.void,
        setConversationTitle: ({ title }) => Effect.sync(() => titles.push(title)),
        setAgentActivity: ({ taskId, active }) =>
          Effect.sync(() => activity.push({ taskId, active })),
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
