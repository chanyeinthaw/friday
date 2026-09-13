import { assert, it } from '@effect/vitest'
import { ChannelThread, ModelSelection, SubagentProfileName } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  makeSystemPromptTemplates,
  SystemPromptTemplates,
  SystemPromptTemplatesLive,
} from './SystemPromptTemplates.ts'
import { DefaultIdentityText, IdentityText } from '../config/IdentityConfiguration.ts'
import { FRIDAY_CLI_PATH } from '../FridayHome.ts'

const decodeIdentityText = Schema.decodeSync(IdentityText)

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
      identityText: decodeIdentityText('Your name is Friday'),
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

    // Required dynamic values are interpolated.
    assert.include(prompt, 'Your name is Friday')
    assert.include(prompt, 'opencode-go/deepseek-v4-flash')
    assert.include(prompt, 'discord')
    assert.include(prompt, 'orbs-at-home')
    assert.include(prompt, 'Development for the orbs-at-home repository.')
    assert.include(prompt, '/tmp/friday/channel-thread')
    assert.include(prompt, '/tmp/friday/channel-thread/<repository-name>')
    assert.include(prompt, FRIDAY_CLI_PATH)
    // Subagent profile metadata is represented.
    assert.include(prompt, '`primary`: General delegated work.')
    assert.include(prompt, 'anthropic/claude-sonnet')
    assert.include(prompt, '- Default')
    assert.include(prompt, '`fast`: Quick investigations.')
    assert.include(prompt, 'openai/gpt-5')
    assert.include(prompt, 'medium')
    // Required functional context is present via stable command and field tokens.
    assert.include(prompt, 'task list')
    assert.include(prompt, 'task inspect')
    assert.include(prompt, 'task set-model')
    assert.include(prompt, 'worktree ensure')
    assert.include(prompt, 'workspace cleanup')
    assert.include(prompt, 'friday/task/')
    assert.include(prompt, 'mayWrite')
    assert.include(prompt, 'participants')
    assert.include(prompt, 'historicalContext')
    assert.include(prompt, 'replyTarget')
    assert.include(prompt, 'trigger')
    assert.include(prompt, 'platformUserId')
    assert.notInclude(prompt, '{{')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('renders channel prompts without configured agent models or a description', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderChannelAgent({
      thread: { ...thread, channelContext: { ...thread.channelContext, description: '' } },
      identityText: decodeIdentityText('Your name is Friday'),
      availableAgentModels: [],
    })

    assert.include(prompt, 'Your name is Friday')
    assert.include(prompt, '(No channel description)')
    assert.include(prompt, '(No subagent profiles are configured.)')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('renders literal custom identity text in the channel identity block', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const identityText = decodeIdentityText(
      'Use this exact text.\nDo not interpolate {{channelName}}.',
    )
    const prompt = yield* templates.renderChannelAgent({
      thread,
      availableAgentModels: [],
      identityText,
    })
    assert.include(prompt, identityText)
    assert.include(prompt, '{{channelName}}')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('defaults the channel identity block when no identity text is provided', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderChannelAgent({
      thread,
      availableAgentModels: [],
    })
    assert.include(prompt, DefaultIdentityText)
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

    assert.include(prompt, '/tmp/friday/bootstrap')
    assert.include(prompt, FRIDAY_CLI_PATH)
    assert.include(prompt, 'worktree ensure')
    assert.include(prompt, '--workspace')
    assert.include(prompt, '--branch')
    assert.include(prompt, '--ref')
    assert.include(prompt, 'friday/task/')
    assert.include(prompt, 'git clone')
    assert.include(prompt, 'tasks/')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('guides durable branch selection and temporary isolation branches', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const channelPrompt = yield* templates.renderChannelAgent({
      thread,
      availableAgentModels: [],
    })

    assert.include(channelPrompt, 'durable branch')
    assert.include(channelPrompt, 'friday/task/')
    assert.include(channelPrompt, 'bootstrap')

    const bootstrapPrompt = yield* templates.renderBootstrapAgent('/tmp/friday/bootstrap')
    assert.include(bootstrapPrompt, '--branch')
    assert.include(bootstrapPrompt, '--ref')
    assert.include(bootstrapPrompt, 'friday/task/')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)

it.effect('allows explicit external paths while keeping task work inside the workspace', () =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const prompt = yield* templates.renderChannelAgent({
      thread,
      availableAgentModels: [],
    })

    assert.include(
      prompt,
      'Keep task working directories and durable files inside the channel workspace.',
    )
    assert.include(
      prompt,
      'You may access a path outside the workspace when the participant explicitly asks you to work with that path.',
    )
    assert.include(
      prompt,
      'Pass the exact path in the task instructions instead of using it as the task working directory.',
    )
    assert.include(prompt, 'Do not inspect unrelated paths.')
    assert.notInclude(prompt, 'Never use `/tmp`')
  }).pipe(Effect.provide(SystemPromptTemplatesLive)),
)
