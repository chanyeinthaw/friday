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
import type { PlatformAdapter } from '../platforms/PlatformAdapter.ts'
import {
  PlatformOperationError,
  PlatformRegistry,
  PlatformRegistryLive,
} from '../platforms/PlatformRegistry.ts'

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

const makePlatform = (events: Array<string>): PlatformAdapter<never> => ({
  kind: 'test',
  publish: ({ text }) => Effect.sync(() => events.push(`publish:${text}`)),
  acknowledge: () => Effect.sync(() => events.push('ack')),
  beginWorking: ({ text }) => Effect.sync(() => events.push(`working:${text}`)),
  updateWorking: ({ text }) => Effect.sync(() => events.push(`update:${text}`)),
  finalizeWorking: ({ text }) => Effect.sync(() => events.push(`finalize:${text}`)),
  withTyping: (_binding, effect) => effect,
})

const makeProgress = (platform: PlatformAdapter<PlatformOperationError>) =>
  Effect.gen(function* () {
    const registry = yield* PlatformRegistry
    yield* registry.register(platform)
    return yield* ChannelProgress
  }).pipe(
    Effect.provide(
      Layer.merge(
        PlatformRegistryLive,
        ChannelProgressLive.pipe(Layer.provide(PlatformRegistryLive)),
      ),
    ),
  )

const userMessage = (text: string) => ({
  source: 'user' as const,
  content: { text, images: [] },
  platformMessageId: messageId,
})

const turnStarted = {
  type: 'turn-started' as const,
  turnId,
  harnessTurnId: null,
  startedAt: '2026-03-21T09:00:00.000Z' as const,
}

it.effect('aggregates parallel tool categories into one working status', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const progress = yield* makeProgress(makePlatform(events))
      yield* progress.accept(thread, userMessage('Do work.'))
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

      assert.deepStrictEqual(events, [
        'ack',
        'working:-# Thinking...',
        'update:-# Reading files...',
        'update:-# Reading files and running commands...',
      ])
    }),
  ),
)

it.effect('ends the progress lifecycle when a turn delegates work', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const progress = yield* makeProgress(makePlatform(events))

      yield* progress.accept(thread, userMessage('Inspect the repository.'))
      yield* progress.finalize(thread, 'I delegated the inspection and will report back.')

      yield* progress.accept(thread, userMessage('How does that work?'))
      yield* progress.observe(thread.id, turnStarted)
      yield* progress.finalize(thread, 'It runs in a background agent thread.')

      assert.deepStrictEqual(events, [
        'ack',
        'working:-# Thinking...',
        'finalize:I delegated the inspection and will report back.',
        'ack',
        'working:-# Thinking...',
        'finalize:It runs in a background agent thread.',
      ])
    }),
  ),
)

it.effect('continues the lifecycle when acknowledgement fails', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const platform = {
        ...makePlatform(events),
        acknowledge: () =>
          Effect.fail(new PlatformOperationError({ kind: 'test', cause: 'discord 404' })),
      }
      const progress = yield* makeProgress(platform)

      yield* progress.accept(thread, userMessage('Do work.'))
      yield* progress.finalize(thread, 'Done.')

      assert.deepStrictEqual(events, ['working:-# Thinking...', 'finalize:Done.'])
    }),
  ),
)

it.effect('falls back to publishing when finalization fails', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const platform = {
        ...makePlatform(events),
        finalizeWorking: () =>
          Effect.fail(new PlatformOperationError({ kind: 'test', cause: 'edit conflict' })),
      }
      const progress = yield* makeProgress(platform)

      yield* progress.accept(thread, userMessage('Do work.'))
      yield* progress.finalize(thread, 'Done.')

      assert.deepStrictEqual(events, ['ack', 'working:-# Thinking...', 'publish:Done.'])
    }),
  ),
)
