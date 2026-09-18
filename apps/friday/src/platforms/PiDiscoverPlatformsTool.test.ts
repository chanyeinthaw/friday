import { assert, it } from '@effect/vitest'
import { ChannelThread } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makePiDiscoverPlatformsTool } from './PiDiscoverPlatformsTool.ts'
import type { PlatformDiscoveryQuery, PlatformDiscoveryResult } from './PlatformAdapter.ts'
import type { PlatformRegistryContract } from './PlatformRegistry.ts'

type Platforms = Pick<PlatformRegistryContract, 'discoverPlatforms'>

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-discover-tool',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/discover-tool',
  model: { provider: 'openai', modelId: 'gpt' },
  thinkingLevel: 'medium',
  channelContext: { name: 'discover', description: '' },
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

const slackThread = Schema.decodeSync(ChannelThread)({
  id: 'thread-discover-tool-slack',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/discover-tool',
  model: { provider: 'openai', modelId: 'gpt' },
  thinkingLevel: 'medium',
  channelContext: { name: 'discover', description: '' },
  conversationBinding: {
    platform: 'slack',
    connectionId: 'slack',
    channelId: 'slack:T123:C456',
    sourceMessageId: '1234567890.111111',
    conversationId: 'slack:T123:C456',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const currentResult: PlatformDiscoveryResult = {
  action: 'current',
  platform: 'discord',
  connectionId: thread.conversationBinding.connectionId,
  current: {
    target: { platform: 'discord', guildId: 'guild-1', channelId: 'channel-1' },
    targetType: 'channel',
    isDirectMessage: false,
  },
}

const discoverStub = (requests: Array<PlatformDiscoveryQuery>): Platforms => ({
  discoverPlatforms: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return currentResult
    }),
})

const neverRun = (): Platforms => ({
  discoverPlatforms: () => Effect.die('should not run'),
})

// SAFETY: The discovery tool does not read ExtensionContext for these operations.
const extensionContext = {} as never

it('is named discover_platforms with no compatibility alias', () => {
  const tool = makePiDiscoverPlatformsTool({
    thread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  assert.strictEqual(tool.name, 'discover_platforms')
})

it('dispatches current without a target on the current connection', async () => {
  const requests: Array<PlatformDiscoveryQuery> = []
  const tool = makePiDiscoverPlatformsTool({
    thread,
    platforms: discoverStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The discovery tool does not read ExtensionContext for these operations.
  const result = await tool.execute(
    'call-1',
    { action: 'current' },
    undefined,
    undefined,
    extensionContext,
  )

  assert.strictEqual(requests.length, 1)
  assert.deepStrictEqual(requests[0], {
    binding: thread.conversationBinding,
    action: 'current',
    limit: 20,
  })
  assert.include(JSON.stringify(result), 'current')
})

it('dispatches scopes with search and pagination', async () => {
  const requests: Array<PlatformDiscoveryQuery> = []
  const tool = makePiDiscoverPlatformsTool({
    thread,
    platforms: discoverStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The discovery tool does not read ExtensionContext for these operations.
  await tool.execute(
    'call-1',
    { action: 'scopes', query: 'guild', limit: 10, cursor: '10' },
    undefined,
    undefined,
    extensionContext,
  )

  assert.deepStrictEqual(requests[0], {
    binding: thread.conversationBinding,
    action: 'scopes',
    query: 'guild',
    limit: 10,
    cursor: '10',
  })
})

it('dispatches threads with an explicit channel target on the current connection', async () => {
  const requests: Array<PlatformDiscoveryQuery> = []
  const tool = makePiDiscoverPlatformsTool({
    thread,
    platforms: discoverStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The discovery tool does not read ExtensionContext for these operations.
  await tool.execute(
    'call-1',
    {
      action: 'threads',
      channelTarget: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
      limit: 5,
    },
    undefined,
    undefined,
    extensionContext,
  )

  assert.deepStrictEqual(requests[0], {
    binding: thread.conversationBinding,
    action: 'threads',
    channelTarget: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
    query: undefined,
    limit: 5,
    cursor: undefined,
  })
})

it('rejects cross-connection thread parents', async () => {
  const tool = makePiDiscoverPlatformsTool({
    thread,
    platforms: discoverStub([]),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    // SAFETY: The discovery tool does not read ExtensionContext for these operations.
    await tool.execute(
      'call-1',
      {
        action: 'threads',
        channelTarget: { platform: 'slack', workspaceId: 'T123', channelId: 'C456' },
      },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /current discord connection/)
})

it('rejects thread targets for thread discovery', async () => {
  const tool = makePiDiscoverPlatformsTool({
    thread,
    platforms: discoverStub([]),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    // SAFETY: The discovery tool does not read ExtensionContext for these operations.
    await tool.execute(
      'call-1',
      {
        action: 'threads',
        channelTarget: {
          platform: 'discord',
          guildId: 'guild-9',
          channelId: 'channel-9',
          threadId: 'thread-9',
        },
      },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /channel target/)
})

it('rejects the guild filter on the Slack connection', async () => {
  const tool = makePiDiscoverPlatformsTool({
    thread: slackThread,
    platforms: discoverStub([]),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    // SAFETY: The discovery tool does not read ExtensionContext for these operations.
    await tool.execute(
      'call-1',
      { action: 'channels', guildId: 'guild-9' },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /Discord-only/)
})

it('rejects blank search filters', async () => {
  const tool = makePiDiscoverPlatformsTool({
    thread,
    platforms: discoverStub([]),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    // SAFETY: The discovery tool does not read ExtensionContext for these operations.
    await tool.execute(
      'call-1',
      { action: 'scopes', query: '  ' },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /non-empty/)
})
