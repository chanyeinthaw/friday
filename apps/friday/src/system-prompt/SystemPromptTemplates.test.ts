import { assert, it } from '@effect/vitest'
import { ChannelThread, ModelSelection, SubagentProfileName } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  makeSystemPromptTemplates,
  SystemPromptTemplates,
  SystemPromptTemplatesLive,
} from './SystemPromptTemplates.ts'

const decodeModel = Schema.decodeSync(ModelSelection)
const decodeProfileName = Schema.decodeSync(SubagentProfileName)

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
    connectionId: 'discord',
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
        {
          name: decodeProfileName('primary'),
          description: 'General delegated work.',
          model: decodeModel({ provider: 'anthropic', modelId: 'claude-sonnet' }),
          thinkingLevel: 'max',
        },
        {
          name: decodeProfileName('fast'),
          description: 'Quick investigations.',
          model: decodeModel({ provider: 'openai', modelId: 'gpt-5' }),
          thinkingLevel: 'medium',
        },
      ],
    })

    assert.include(prompt, '- Platform: discord')
    assert.include(prompt, '- Channel: orbs-at-home')
    assert.include(prompt, 'Development for the orbs-at-home repository.')
    assert.include(prompt, '`/tmp/friday/channel-thread`')
    assert.include(prompt, '`/tmp/friday/channel-thread/<repository-name>`')
    assert.include(prompt, 'runs directly at `/tmp/friday/channel-thread`')
    assert.include(prompt, 'Do not create a `tasks/` directory')
    assert.include(prompt, 'Never choose `/tmp` or a directory outside the channel workspace')
    assert.include(prompt, '`primary`: General delegated work.')
    assert.include(prompt, 'Model: `anthropic/claude-sonnet`')
    assert.include(prompt, 'Thinking: `max`')
    assert.include(prompt, '- Default')
    assert.include(prompt, '`fast`: Quick investigations.')
    assert.include(prompt, 'workspace cleanup apply <proposal-id> --json')
    assert.include(prompt, '.friday/bin/friday')
    assert.include(prompt, 'Messages may come from different people')
    assert.include(prompt, 'Do not assume that a new message was written by the same person')
    assert.include(prompt, 'Background tasks are private implementation details')
    assert.include(prompt, 'Say "I\'m still working on it,"')
    assert.include(prompt, 'Do not mention subagents, background agents, agent threads')
    assert.include(prompt, "begin with that participant's native mention")
    assert.include(prompt, 'Use the native mention token verbatim')
    assert.include(
      prompt,
      'If you cannot confidently identify the related participant, do not guess',
    )
    assert.include(prompt, 'even if other people have spoken since they made the request')
    assert.include(prompt, 'respond as one coherent agent')
    assert.notInclude(prompt, '{{')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('renders channel prompts without configured agent models or a description', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderChannelAgent({
      thread: { ...thread, channelContext: { ...thread.channelContext, description: '' } },
      availableAgentModels: [],
    })

    assert.include(prompt, '(No channel description)')
    assert.include(prompt, '(No subagent profiles are configured.)')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('rejects templates with missing variables', () =>
  Effect.gen(function* () {
    const templates = makeSystemPromptTemplates({
      channelAgent: '{{channelName}} {{missingValue}} {{anotherMissingValue}}',
      bootstrapAgent: 'Bootstrap',
    })
    const error = yield* Effect.flip(
      templates.renderChannelAgent({ thread, availableAgentModels: [] }),
    )

    assert.strictEqual(error.template, 'channel-agent')
    assert.strictEqual(error.detail, 'Missing template variables: missingValue,anotherMissingValue')
  }),
)

it.effect('reports the bootstrap template when its variables are missing', () =>
  Effect.gen(function* () {
    const templates = makeSystemPromptTemplates({
      channelAgent: 'Channel',
      bootstrapAgent: '{{bootstrapVariable}}',
    })
    const error = yield* Effect.flip(templates.renderBootstrapAgent('/tmp/friday/bootstrap'))

    assert.strictEqual(error.template, 'bootstrap-agent')
    assert.strictEqual(error.detail, 'Missing template variables: bootstrapVariable')
  }),
)

it.effect('supports multi-character alphanumeric variable names', () =>
  Effect.gen(function* () {
    const templates = makeSystemPromptTemplates({
      channelAgent: '{{channelName2}}',
      bootstrapAgent: 'Bootstrap',
    })
    const error = yield* Effect.flip(
      templates.renderChannelAgent({ thread, availableAgentModels: [] }),
    )

    assert.strictEqual(error.detail, 'Missing template variables: channelName2')
  }),
)

it.effect('trims rendered templates', () =>
  Effect.gen(function* () {
    const templates = makeSystemPromptTemplates({
      channelAgent: '  {{channelName}}  \n',
      bootstrapAgent: '  Bootstrap  \n',
    })

    assert.strictEqual(
      yield* templates.renderChannelAgent({ thread, availableAgentModels: [] }),
      'orbs-at-home',
    )
    assert.strictEqual(yield* templates.renderBootstrapAgent('/tmp/friday/bootstrap'), 'Bootstrap')
  }),
)

it.effect('renders the bootstrap prompt without replacing Pi for normal subagents', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderBootstrapAgent('/tmp/friday/bootstrap')

    assert.include(prompt, 'You are a bootstrap agent running inside Friday.')
    assert.include(prompt, "Do not perform the user's main task.")
    assert.include(prompt, '`<workspace-root>/<repository-name>`')
    assert.include(prompt, 'worktree ensure <repository-url>')
    assert.include(prompt, '--workspace "/tmp/friday/bootstrap" --json')
    assert.include(prompt, 'Do not run `git clone`')
    assert.include(prompt, 'Do not create a `tasks/` directory')
    assert.include(prompt, 'reuses that worktree')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)
