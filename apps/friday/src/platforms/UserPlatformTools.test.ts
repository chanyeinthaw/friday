import { assert, it } from '@effect/vitest'
import { AgentThread, ChannelThread } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makeUserFacingPlatformTools } from './UserPlatformTools.ts'
import type { PlatformRegistryContract } from './PlatformRegistry.ts'

const platforms: Pick<PlatformRegistryContract, 'searchMessages' | 'getMessage' | 'postMessage'> = {
  searchMessages: () => Effect.die('should not run'),
  getMessage: () => Effect.die('should not run'),
  postMessage: () => Effect.die('should not run'),
}

const userThread = Schema.decodeSync(ChannelThread)({
  id: 'thread-user-tools',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/user-tools',
  model: { provider: 'openai', modelId: 'gpt' },
  thinkingLevel: 'medium',
  channelContext: { name: 'tools', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'discord:guild:channel',
    sourceMessageId: 'message-1',
    conversationId: 'discord:guild:channel:thread',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

it('registers query and post tools for user threads', () => {
  const tools = makeUserFacingPlatformTools({
    thread: userThread,
    platforms,
    runPromise: Effect.runPromise,
  })

  assert.deepStrictEqual(
    tools.map((tool) => tool.name),
    ['query_platform', 'post_platform'],
  )
})

const decodeAgentThread = Schema.decodeSync(AgentThread)

it('registers no platform tools for agent threads', () => {
  const agentThread = decodeAgentThread({
    id: 'thread-agent-tools',
    audience: 'agent',
    parent: { threadId: 'thread-user-tools', turnId: 'turn-1' },
    role: 'subagent',
    harness: 'pi',
    harnessSession: null,
    workingDirectory: '/tmp/user-tools',
    model: { provider: 'openai', modelId: 'gpt' },
    thinkingLevel: 'medium',
    conversationBinding: null,
    status: 'active',
    createdAt: '2026-03-21T09:00:00.000Z',
    updatedAt: '2026-03-21T09:00:00.000Z',
    closedAt: null,
  })
  const tools = makeUserFacingPlatformTools({
    thread: agentThread,
    platforms,
    runPromise: Effect.runPromise,
  })

  assert.deepStrictEqual(tools, [])
})
