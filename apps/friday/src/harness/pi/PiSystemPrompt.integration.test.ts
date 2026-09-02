/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/multiple-effect-provide, effecttsgo/strict-effect-provide, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion -- The injected Pi SDK factory is Promise-based; the test supplies the narrow ModelRuntime methods exercised before the injected session factory runs. */

import { expect, test } from 'bun:test'
import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import {
  AgentThread,
  ChannelThread,
  ModelSelection,
  SubagentProfileName,
  type Thread,
} from '@friday/contracts/conversation'
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent'
import type { AppConfig } from '../../config/AppConfig.ts'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'

import {
  SystemPromptTemplateError,
  SystemPromptTemplates,
  SystemPromptTemplatesLive,
  type SystemPromptTemplatesContract,
} from '../../system-prompt/SystemPromptTemplates.ts'
import type { PiTaskOperations } from '../../tasks/PiTaskTool.ts'
import { makePiThreadRuntime, type PiAgentSessionContract } from './PiThreadRuntime.ts'

const decodeChannelThread = Schema.decodeSync(ChannelThread)
const decodeModel = Schema.decodeSync(ModelSelection)
const decodeProfileName = Schema.decodeSync(SubagentProfileName)
const decodeAgentThread = Schema.decodeSync(AgentThread)

const channelThread = decodeChannelThread({
  id: 'thread-prompt-channel',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/prompt-channel',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'prompt-test', description: 'Prompt integration tests.' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'channel-prompt-test',
    sourceMessageId: 'message-prompt-test',
    conversationId: 'conversation-prompt-test',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const agentThread = (role: 'subagent' | 'bootstrap') =>
  decodeAgentThread({
    id: `thread-prompt-${role}`,
    audience: 'agent',
    parent: { threadId: channelThread.id, turnId: 'turn-parent' },
    role,
    subagentProfile: 'primary',
    harness: 'pi',
    harnessSession: null,
    workingDirectory: `/tmp/friday/prompt-${role}`,
    model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
    thinkingLevel: 'max',
    conversationBinding: null,
    status: 'active',
    createdAt: '2026-03-21T09:00:00.000Z',
    updatedAt: '2026-03-21T09:00:00.000Z',
    closedAt: null,
  })

const session = (): PiAgentSessionContract => ({
  sessionId: 'pi-session-system-prompt',
  sessionManager: { getSessionFile: () => undefined },
  subscribe: () => () => undefined,
  bindExtensions: async () => undefined,
  prompt: async () => undefined,
  abort: async () => undefined,
  reload: async () => undefined,
  dispose: () => undefined,
  getSessionStats: () => ({
    sessionFile: undefined,
    sessionId: 'pi-session-system-prompt',
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  }),
})

const tasks: PiTaskOperations = {
  start: () => Effect.die('not exercised'),
  bootstrap: () => Effect.die('not exercised'),
  steer: () => Effect.die('not exercised'),
  list: () => Effect.die('not exercised'),
  cancel: () => Effect.die('not exercised'),
}

const open = (thread: Thread, captured: Array<CreateAgentSessionOptions>) =>
  Effect.gen(function* () {
    const templates = yield* SystemPromptTemplates
    const scope = yield* Scope.make()
    yield* makePiThreadRuntime({
      thread,
      systemPromptTemplates: templates,
      availableAgentModels: () => [
        {
          name: decodeProfileName('primary'),
          description: 'General delegated work.',
          model: decodeModel({ provider: 'anthropic', modelId: 'claude-sonnet' }),
          thinkingLevel: 'max',
        },
      ],
      tasks,
      modelRuntime: {
        getModel: () => ({ provider: 'opencode-go', id: 'deepseek-v4-flash' }),
        getAuth: async () => ({ type: 'api_key', key: 'test' }),
      } as never,
      createSession: async (options) => {
        captured.push(options)
        return { session: session() }
      },
    }).pipe(Effect.provideService(Scope.Scope, scope))
    yield* Scope.close(scope, Exit.void)
  }).pipe(Effect.provide(SystemPromptTemplatesLive), Effect.provide(BunCrypto.layer))

test('harness reload rerenders the channel prompt with current profile configuration', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let promptRevision = 'first prompt'
        let profiles: AppConfig['models']['subagents'] = [
          {
            name: decodeProfileName('primary'),
            description: 'Initial profile.',
            model: decodeModel({ provider: 'anthropic', modelId: 'claude-sonnet' }),
            thinkingLevel: 'max',
          },
        ]
        const templates: SystemPromptTemplatesContract = {
          renderChannelAgent: ({ availableAgentModels }) =>
            Effect.succeed(
              `${promptRevision}\n${availableAgentModels.map(({ description }) => description).join('\n')}`,
            ),
          renderBootstrapAgent: () => Effect.succeed('bootstrap'),
        }
        let loader: CreateAgentSessionOptions['resourceLoader']
        const runtime = yield* makePiThreadRuntime({
          thread: channelThread,
          systemPromptTemplates: templates,
          availableAgentModels: () => profiles,
          modelRuntime: {
            getModel: () => ({ provider: 'opencode-go', id: 'deepseek-v4-flash' }),
            getAuth: async () => ({ type: 'api_key', key: 'test' }),
          } as never,
          createSession: async (options) => {
            loader = options.resourceLoader
            return {
              session: {
                ...session(),
                reload: async () => loader?.reload(),
              },
            }
          },
        })

        expect(loader?.getSystemPrompt()).toBe('first prompt\nInitial profile.')
        promptRevision = 'second prompt'
        profiles = [
          {
            name: decodeProfileName('primary'),
            description: 'Reloaded profile.',
            model: decodeModel({ provider: 'openai', modelId: 'gpt-5' }),
            thinkingLevel: 'medium',
          },
        ]

        expect(yield* runtime.reload()).toEqual({ ok: true })
        expect(loader?.getSystemPrompt()).toBe('second prompt\nReloaded profile.')
        expect(String(runtime.harnessSession.id)).toBe('pi-session-system-prompt')
      }),
    ).pipe(Effect.provide(BunCrypto.layer)),
  )
})

test('failed Pi reload restores the prompt that was active before reload', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let prompt = 'stable prompt'
        const templates: SystemPromptTemplatesContract = {
          renderChannelAgent: () => Effect.succeed(prompt),
          renderBootstrapAgent: () => Effect.succeed('bootstrap'),
        }
        let loader: CreateAgentSessionOptions['resourceLoader']
        const runtime = yield* makePiThreadRuntime({
          thread: channelThread,
          systemPromptTemplates: templates,
          modelRuntime: {
            getModel: () => ({ provider: 'opencode-go', id: 'deepseek-v4-flash' }),
            getAuth: async () => ({ type: 'api_key', key: 'test' }),
          } as never,
          createSession: async (options) => {
            loader = options.resourceLoader
            return {
              session: {
                ...session(),
                reload: async () => {
                  await loader?.reload()
                  throw new Error('extension reload failed')
                },
              },
            }
          },
        })

        prompt = 'prompt that must roll back'
        expect(yield* runtime.reload()).toEqual({
          ok: false,
          reason: 'reload-failed',
          detail: 'extension reload failed',
        })
        expect(loader?.getSystemPrompt()).toBe('stable prompt')
      }),
    ).pipe(Effect.provide(BunCrypto.layer)),
  )
})

test('failed prompt rendering leaves the current prompt and session untouched', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let failRendering = false
        const templates: SystemPromptTemplatesContract = {
          renderChannelAgent: () =>
            failRendering
              ? Effect.fail(
                  new SystemPromptTemplateError({
                    template: 'channel-agent',
                    detail: 'template is invalid',
                  }),
                )
              : Effect.succeed('working prompt'),
          renderBootstrapAgent: () => Effect.succeed('bootstrap'),
        }
        let loader: CreateAgentSessionOptions['resourceLoader']
        let sessionReloads = 0
        const runtime = yield* makePiThreadRuntime({
          thread: channelThread,
          systemPromptTemplates: templates,
          modelRuntime: {
            getModel: () => ({ provider: 'opencode-go', id: 'deepseek-v4-flash' }),
            getAuth: async () => ({ type: 'api_key', key: 'test' }),
          } as never,
          createSession: async (options) => {
            loader = options.resourceLoader
            return {
              session: {
                ...session(),
                reload: async () => {
                  sessionReloads++
                  await loader?.reload()
                },
              },
            }
          },
        })

        failRendering = true
        expect(yield* runtime.reload()).toEqual({
          ok: false,
          reason: 'reload-failed',
          detail: 'template is invalid',
        })
        expect(sessionReloads).toBe(0)
        expect(loader?.getSystemPrompt()).toBe('working prompt')
      }),
    ).pipe(Effect.provide(BunCrypto.layer)),
  )
})

test('sets role prompts and appends the model hint to normal subagents', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const channelOptions: Array<CreateAgentSessionOptions> = []
      yield* open(channelThread, channelOptions)
      const channelPrompt = channelOptions[0]?.resourceLoader?.getSystemPrompt()
      expect(channelPrompt ?? '').toContain('# Friday channel agent')
      expect(channelPrompt ?? '').toContain('## Runtime model')
      expect(channelPrompt ?? '').toContain('Model: `opencode-go/deepseek-v4-flash`')
      expect(channelPrompt ?? '').toContain('Thinking level: `max`')
      expect(channelPrompt ?? '').toContain('`primary`: General delegated work.')
      expect(channelPrompt ?? '').toContain('Model: `anthropic/claude-sonnet`')
      expect(channelOptions[0]?.customTools?.map((tool) => tool.name)).toEqual(['task'])

      const bootstrapOptions: Array<CreateAgentSessionOptions> = []
      yield* open(agentThread('bootstrap'), bootstrapOptions)
      expect(bootstrapOptions[0]?.resourceLoader?.getSystemPrompt() ?? '').toContain(
        '# Friday bootstrap agent',
      )
      expect(bootstrapOptions[0]?.customTools).toBeUndefined()

      const subagentOptions: Array<CreateAgentSessionOptions> = []
      yield* open(agentThread('subagent'), subagentOptions)
      const subagentLoader = subagentOptions[0]?.resourceLoader
      expect(subagentLoader?.getSystemPrompt()).toBeUndefined()
      expect(subagentLoader?.getAppendSystemPrompt()).toContain(
        '## Runtime model\n\n- Model: `opencode-go/deepseek-v4-flash`\n- Thinking level: `max`',
      )
      expect(subagentOptions[0]?.customTools).toBeUndefined()
    }),
  )
})
