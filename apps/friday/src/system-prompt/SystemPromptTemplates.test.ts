import { assert, it } from '@effect/vitest'
import { ChannelThread, ModelSelection } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { SystemPromptTemplates, SystemPromptTemplatesLive } from './SystemPromptTemplates.ts'

const decodeModelSelection = Schema.decodeSync(ModelSelection)

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-system-prompt',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/channel-thread',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: {
    name: 'orbs-at-home',
    description: 'Development for the orbs-at-home repository.',
  },
  conversationBinding: {
    platform: 'discord',
    channelId: 'channel-system-prompt',
    sourceMessageId: 'message-system-prompt',
    conversationId: 'conversation-system-prompt',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

it.effect('renders the channel agent system prompt from thread context and configured models', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderChannelAgent({
      thread,
      availableAgentModels: [
        decodeModelSelection({ provider: 'anthropic', modelId: 'claude-sonnet' }),
        decodeModelSelection({ provider: 'openai', modelId: 'gpt-5' }),
      ],
    })

    assert.include(prompt, '- Platform: discord')
    assert.include(prompt, '- Channel: orbs-at-home')
    assert.include(prompt, 'Development for the orbs-at-home repository.')
    assert.include(prompt, '`/tmp/friday/channel-thread`')
    assert.include(prompt, '- Default: `anthropic/claude-sonnet`')
    assert.include(prompt, '- `openai/gpt-5`')
    assert.notInclude(prompt, '{{')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('renders the bootstrap prompt without replacing Pi for normal subagents', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderBootstrapAgent

    assert.include(prompt, 'You are a bootstrap agent running inside Friday.')
    assert.include(prompt, "Do not perform the user's main task.")
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)
