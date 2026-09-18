import { assert, it } from '@effect/vitest'
import { ChannelThread, MessageAuthor, PlatformMessageId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makePiQueryPlatformTool } from './PiQueryPlatformTool.ts'
import type {
  PlatformMembersQuery,
  PlatformMessageGetQuery,
  PlatformMessageQuery,
} from './PlatformAdapter.ts'
import type { PlatformRegistryContract } from './PlatformRegistry.ts'

type Platforms = Pick<PlatformRegistryContract, 'searchMessages' | 'getMessage' | 'listMembers'>

const decodeMessageId = Schema.decodeSync(PlatformMessageId)
const decodeAuthor = Schema.decodeSync(MessageAuthor)
const message9 = {
  id: decodeMessageId('message-9'),
  author: decodeAuthor({
    platformUserId: 'user-1',
    mention: '<@user-1>',
    username: 'user-1',
    displayName: 'user-1',
  }),
  text: 'hello',
  sentAt: null,
  replyToMessageId: null,
  attachments: [],
}

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-query-tool',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/query-tool',
  model: { provider: 'openai', modelId: 'gpt' },
  thinkingLevel: 'medium',
  channelContext: { name: 'query', description: '' },
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

const searchStub = (requests: Array<PlatformMessageQuery>): Platforms => ({
  searchMessages: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return { messages: [], scannedCount: 12, truncated: false }
    }),
  getMessage: () => Effect.die('should not run'),
  listMembers: () => Effect.die('should not run'),
})

const getStub = (requests: Array<PlatformMessageGetQuery>): Platforms => ({
  searchMessages: () => Effect.die('should not run'),
  getMessage: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return { message: message9 }
    }),
  listMembers: () => Effect.die('should not run'),
})

const neverRun = (): Platforms => ({
  searchMessages: () => Effect.die('should not run'),
  listMembers: () => Effect.die('should not run'),
  getMessage: () => Effect.die('should not run'),
})

// SAFETY: The query tool does not read ExtensionContext for these operations.
const extensionContext = {} as never

const decodeSlackThread = Schema.decodeSync(ChannelThread)
const encodeThread = Schema.encodeSync(ChannelThread)

it('is named query_platform with no compatibility alias', () => {
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  assert.strictEqual(tool.name, 'query_platform')
})

it('dispatches bounded search through an explicit target on the current connection', async () => {
  const requests: Array<PlatformMessageQuery> = []
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: searchStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The query tool does not read ExtensionContext for these operations.
  const result = await tool.execute(
    'call-1',
    {
      action: 'search',
      target: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
      query: 'Dokploy',
      limit: 10,
    },
    undefined,
    undefined,
    extensionContext,
  )

  assert.strictEqual(requests.length, 1)
  assert.deepStrictEqual(requests[0], {
    binding: thread.conversationBinding,
    target: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
    limit: 10,
    query: 'Dokploy',
    before: undefined,
    authorId: undefined,
  })
  assert.deepStrictEqual(result.details, { messages: [], scannedCount: 12, truncated: false })
})

it('dispatches fetch without a query and defaults the limit', async () => {
  const requests: Array<PlatformMessageQuery> = []
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: searchStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The query tool does not read ExtensionContext for these operations.
  await tool.execute(
    'call-1',
    {
      action: 'fetch',
      target: { platform: 'discord', guildId: 'guild-1', threadId: 'thread-1' },
      before: 'message-5',
    },
    undefined,
    undefined,
    extensionContext,
  )

  assert.deepStrictEqual(requests[0], {
    binding: thread.conversationBinding,
    target: { platform: 'discord', guildId: 'guild-1', threadId: 'thread-1' },
    limit: 20,
    query: undefined,
    before: decodeMessageId('message-5'),
    authorId: undefined,
  })
})

it('dispatches a matching-workspace Slack fetch on the current connection', async () => {
  const slackThread = decodeSlackThread({
    ...encodeThread(thread),
    conversationBinding: {
      platform: 'slack',
      connectionId: 'slack',
      channelId: 'slack:T123:C456',
      sourceMessageId: '1234567890.111111',
      conversationId: 'slack:T123:C456',
    },
  })
  const requests: Array<PlatformMessageQuery> = []
  const tool = makePiQueryPlatformTool({
    thread: slackThread,
    platforms: searchStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The query tool does not read ExtensionContext for these operations.
  await tool.execute(
    'call-1',
    {
      action: 'fetch',
      target: { platform: 'slack', workspaceId: 'T123', channelId: 'C456' },
      limit: 10,
    },
    undefined,
    undefined,
    extensionContext,
  )

  assert.strictEqual(requests.length, 1)
  assert.deepStrictEqual(requests[0]?.target, {
    platform: 'slack',
    workspaceId: 'T123',
    channelId: 'C456',
  })
})

it('rejects cross-connection targets', async () => {
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    await tool.execute(
      'call-1',
      {
        action: 'search',
        target: { platform: 'slack', workspaceId: 'T123', channelId: 'C456' },
        query: 'hello',
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

it('rejects search without a query', async () => {
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    await tool.execute(
      'call-1',
      {
        action: 'search',
        target: { platform: 'discord', guildId: 'guild-1', channelId: 'channel-1' },
        query: '   ',
      },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /Search requires a non-empty query/)
})

it('dispatches single-message retrieval by id against an explicit target', async () => {
  const requests: Array<PlatformMessageGetQuery> = []
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: getStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The query tool does not read ExtensionContext for these operations.
  const result = await tool.execute(
    'call-1',
    {
      action: 'get',
      target: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
      messageId: 'message-9',
    },
    undefined,
    undefined,
    extensionContext,
  )

  assert.deepStrictEqual(requests, [
    {
      binding: thread.conversationBinding,
      target: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
      messageId: decodeMessageId('message-9'),
      messageUrl: undefined,
    },
  ])
  assert.deepStrictEqual(result.details, { message: message9 })
})

it('dispatches single-message retrieval by URL without a target', async () => {
  const requests: Array<PlatformMessageGetQuery> = []
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: getStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The query tool does not read ExtensionContext for these operations.
  await tool.execute(
    'call-1',
    { action: 'get', messageUrl: 'https://discord.com/channels/guild/channel/message-9' },
    undefined,
    undefined,
    extensionContext,
  )

  assert.deepStrictEqual(requests, [
    {
      binding: thread.conversationBinding,
      target: undefined,
      messageId: undefined,
      messageUrl: 'https://discord.com/channels/guild/channel/message-9',
    },
  ])
})

it('requires a target for bare message ids', async () => {
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    await tool.execute(
      'call-1',
      { action: 'get', messageId: 'message-9' },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /requires an explicit target/)
})

it('rejects Slack URLs with a clear permalink error', async () => {
  const slackThread = decodeSlackThread({
    ...encodeThread(thread),
    conversationBinding: {
      platform: 'slack',
      connectionId: 'slack',
      channelId: 'slack:T123:C456',
      sourceMessageId: '1234567890.111111',
      conversationId: 'slack:T123:C456',
    },
  })
  const tool = makePiQueryPlatformTool({
    thread: slackThread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    await tool.execute(
      'call-1',
      {
        action: 'get',
        target: { platform: 'slack', workspaceId: 'T123', channelId: 'C456' },
        messageUrl: 'https://example.slack.com/archives/C456/p123',
      },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /permalink/i)
})

it('rejects get without exactly one of messageUrl or messageId', async () => {
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  const errors = await Promise.all(
    [
      { action: 'get', target: { platform: 'discord', guildId: 'g', channelId: 'c' } },
      {
        action: 'get',
        target: { platform: 'discord', guildId: 'g', channelId: 'c' },
        messageUrl: '  ',
      },
      {
        action: 'get',
        target: { platform: 'discord', guildId: 'g', channelId: 'c' },
        messageUrl: 'https://discord.com/channels/g/c/message-9',
        messageId: 'message-9',
      },
    ].map(async (input) => {
      try {
        await tool.execute('call-1', input, undefined, undefined, extensionContext)
      } catch (cause) {
        return cause
      }
      return undefined
    }),
  )
  for (const error of errors) {
    assert.match(String(error), /exactly one of messageUrl or messageId/)
  }
})

it('rejects Discord targets missing both channel and thread', async () => {
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    await tool.execute(
      'call-1',
      { action: 'fetch', target: { platform: 'discord', guildId: 'guild-1' } },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.isDefined(error)
})

it('dispatches bounded members through an explicit target on the current connection', async () => {
  const requests: Array<PlatformMembersQuery> = []
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: {
      searchMessages: () => Effect.die('should not run'),
      getMessage: () => Effect.die('should not run'),
      listMembers: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return { members: [], truncated: false }
        }),
    },
    runPromise: Effect.runPromise,
  })

  // SAFETY: The query tool does not read ExtensionContext for these operations.
  await tool.execute(
    'call-1',
    {
      action: 'members',
      target: {
        platform: 'discord',
        guildId: 'guild-9',
        channelId: 'channel-9',
        threadId: 'thread-9',
      },
      limit: 10,
      cursor: 'after-U1',
    },
    undefined,
    undefined,
    extensionContext,
  )

  assert.strictEqual(requests.length, 1)
  assert.deepStrictEqual(requests[0], {
    binding: thread.conversationBinding,
    target: {
      platform: 'discord',
      guildId: 'guild-9',
      channelId: 'channel-9',
      threadId: 'thread-9',
    },
    limit: 10,
    cursor: 'after-U1',
  })
})

it('rejects cross-connection members targets', async () => {
  const tool = makePiQueryPlatformTool({
    thread,
    platforms: neverRun(),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    await tool.execute(
      'call-1',
      { action: 'members', target: { platform: 'slack', workspaceId: 'T123', channelId: 'C456' } },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /current discord connection/)
})
