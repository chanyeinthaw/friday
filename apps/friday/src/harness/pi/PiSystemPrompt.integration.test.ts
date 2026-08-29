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
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'

import { SystemPromptTemplatesLive } from '../../system-prompt/SystemPromptTemplates.ts'
import { SystemPromptTemplates } from '../../system-prompt/SystemPromptTemplates.ts'
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
      availableAgentModels: [
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

test('overrides Pi system prompts for channel and bootstrap agents only', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const channelOptions: Array<CreateAgentSessionOptions> = []
      yield* open(channelThread, channelOptions)
      const channelPrompt = channelOptions[0]?.resourceLoader?.getSystemPrompt()
      expect(channelPrompt ?? '').toContain('# Friday channel agent')
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
      expect(subagentOptions[0]?.resourceLoader).toBeUndefined()
      expect(subagentOptions[0]?.customTools).toBeUndefined()
    }),
  )
})
