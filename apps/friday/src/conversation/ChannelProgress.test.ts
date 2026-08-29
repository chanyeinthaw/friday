import { assert, it } from '@effect/vitest'
import {
  ActivityId,
  ChannelThread,
  PlatformMessageId,
  ToolCallId,
  TurnId,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import { ChannelProgress, ChannelProgressLive } from './ChannelProgress.ts'
import { PlatformRegistry, PlatformRegistryLive } from '../platforms/PlatformRegistry.ts'
import type { PlatformAdapter } from '../platforms/PlatformAdapter.ts'

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-progress',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/progress',
  model: { provider: 'openai', modelId: 'gpt' },
  thinkingLevel: 'medium',
  channelContext: { name: 'progress', description: '' },
  conversationBinding: {
    platform: 'test',
    channelId: 'channel-progress',
    sourceMessageId: 'message-progress',
    conversationId: 'conversation-progress',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})
const turnId = Schema.decodeSync(TurnId)('turn-progress')
const activityId = Schema.decodeSync(ActivityId)
const callId = Schema.decodeSync(ToolCallId)
const messageId = Schema.decodeSync(PlatformMessageId)('message-progress')

it.effect('aggregates parallel tool categories into one working status', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const platform: PlatformAdapter<never> = {
        kind: 'test',
        publish: () => Effect.void,
        acknowledge: () => Effect.sync(() => events.push('ack')),
        beginWorking: ({ text }) => Effect.sync(() => events.push(text)),
        updateWorking: ({ text }) => Effect.sync(() => events.push(text)),
        finalizeWorking: ({ text }) => Effect.sync(() => events.push(text)),
        withTyping: (_binding, effect) => effect,
      }
      const registry = yield* PlatformRegistry
      yield* registry.register(platform)
      const progress = yield* ChannelProgress
      yield* progress.accept(thread, {
        source: 'user',
        content: { text: 'Do work.', images: [] },
        platformMessageId: messageId,
      })
      const toolCall = (id: string, toolName: string) => ({
        type: 'activity-completed' as const,
        turnId,
        activity: {
          id: activityId(`activity-${id}`),
          sequence: 0,
          status: 'completed' as const,
          type: 'tool-call' as const,
          callId: callId(id),
          toolName,
          input: {},
          createdAt: '2026-03-21T09:00:00.000Z' as const,
          updatedAt: '2026-03-21T09:00:00.000Z' as const,
          completedAt: '2026-03-21T09:00:00.000Z' as const,
        },
      })
      yield* progress.observe(thread.id, toolCall('read-call', 'read'))
      yield* progress.observe(thread.id, toolCall('bash-call', 'bash'))
      yield* progress.taskStarted(thread)

      assert.deepStrictEqual(events, [
        'ack',
        '-# Thinking...',
        '-# Reading files...',
        '-# Reading files and running commands...',
        '-# Task delegated, waiting...',
      ])
    }).pipe(
      Effect.provide(
        Layer.merge(
          PlatformRegistryLive,
          ChannelProgressLive.pipe(Layer.provide(PlatformRegistryLive)),
        ),
      ),
    ),
  ),
)
