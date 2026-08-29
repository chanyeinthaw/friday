import { assert, it } from '@effect/vitest'
import { ChannelThread } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { ConversationTitles, ConversationTitlesLive } from './ConversationTitles.ts'
import type { PlatformAdapter } from './PlatformAdapter.ts'
import { PlatformRegistry, PlatformRegistryLive } from './PlatformRegistry.ts'

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
      const counts: Array<number> = []
      const platform: PlatformAdapter<never> = {
        kind: 'test',
        publish: () => Effect.void,
        acknowledge: () => Effect.void,
        beginWorking: () => Effect.void,
        updateWorking: () => Effect.void,
        finalizeWorking: () => Effect.void,
        setConversationTitle: ({ title }) => Effect.sync(() => titles.push(title)),
        setAgentActivity: ({ activeTaskCount }) => Effect.sync(() => counts.push(activeTaskCount)),
        withTyping: (_binding, effect) => effect,
      }
      const registry = yield* PlatformRegistry
      yield* registry.register(platform)
      const conversationTitles = yield* ConversationTitles

      yield* conversationTitles.generated(thread, 'Repository Inspection')
      yield* conversationTitles.taskStarted(thread)
      yield* conversationTitles.taskStarted(thread)
      yield* conversationTitles.taskFinished(thread)
      yield* conversationTitles.taskFinished(thread)

      assert.deepStrictEqual(titles, ['Repository Inspection'])
      assert.deepStrictEqual(counts, [1, 2, 1, 0])
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
