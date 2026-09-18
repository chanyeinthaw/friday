import { assert, it } from '@effect/vitest'
import { ChannelThread, MessageAuthor, PlatformMessageId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makePiMessagesTool } from './PiMessagesTool.ts'
import type { PlatformMessageGetQuery, PlatformMessageQuery } from './PlatformAdapter.ts'
import type { PlatformRegistryContract } from './PlatformRegistry.ts'

type Platforms = Pick<PlatformRegistryContract, 'searchMessages' | 'getMessage'>

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
  id: 'thread-messages-tool',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/messages-tool',
  model: { provider: 'openai', modelId: 'gpt' },
  thinkingLevel: 'medium',
  channelContext: { name: 'messages', description: '' },
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

const searchStub = (): Platforms => ({
  searchMessages: (request) =>
    Effect.sync(() => {
      searchRequests.push(request)
      return { messages: [], scannedCount: 12, truncated: false }
    }),
  getMessage: () => Effect.die('should not run'),
})
const searchRequests: Array<PlatformMessageQuery> = []

const getStub = (requests: Array<PlatformMessageGetQuery>): Platforms => ({
  searchMessages: () => Effect.die('should not run'),
  getMessage: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return { message: message9 }
    }),
})

const neverGet = (): Platforms => ({
  searchMessages: () => Effect.die('should not run'),
  getMessage: () => Effect.die('should not run'),
})

it('dispatches bounded thread search through the current binding', async () => {
  searchRequests.length = 0
  const tool = makePiMessagesTool({
    thread,
    platforms: searchStub(),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The messages tool does not read ExtensionContext for these operations.
  const result = await tool.execute(
    'call-1',
    {
      action: 'search',
      scope: 'thread',
      query: 'Dokploy',
      limit: 10,
    },
    undefined,
    undefined,
    {} as never,
  )

  assert.strictEqual(searchRequests.length, 1)
  assert.deepStrictEqual(searchRequests[0], {
    binding: thread.conversationBinding,
    scope: 'thread',
    limit: 10,
    query: 'Dokploy',
    before: undefined,
    authorId: undefined,
  })
  assert.deepStrictEqual(result.details, { messages: [], scannedCount: 12, truncated: false })
})

it('rejects search without a query', async () => {
  const tool = makePiMessagesTool({ thread, platforms: neverGet(), runPromise: Effect.runPromise })

  let error: unknown
  try {
    // SAFETY: The messages tool does not read ExtensionContext for these operations.
    await tool.execute(
      'call-1',
      { action: 'search', scope: 'channel' },
      undefined,
      undefined,
      {} as never,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /Search requires a non-empty query/)
})

it('dispatches single-message retrieval by id against the selected scope', async () => {
  const requests: Array<PlatformMessageGetQuery> = []
  const tool = makePiMessagesTool({
    thread,
    platforms: getStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The messages tool does not read ExtensionContext for these operations.
  const result = await tool.execute(
    'call-1',
    { action: 'get', scope: 'channel', messageId: 'message-9' },
    undefined,
    undefined,
    {} as never,
  )

  assert.deepStrictEqual(requests, [
    {
      binding: thread.conversationBinding,
      scope: 'channel',
      messageId: decodeMessageId('message-9'),
      messageUrl: undefined,
    },
  ])
  assert.deepStrictEqual(result.details, { message: message9 })
})

it('defaults single-message retrieval by id to the thread scope', async () => {
  const requests: Array<PlatformMessageGetQuery> = []
  const tool = makePiMessagesTool({
    thread,
    platforms: getStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The messages tool does not read ExtensionContext for these operations.
  await tool.execute(
    'call-1',
    { action: 'get', messageId: 'message-9' },
    undefined,
    undefined,
    {} as never,
  )

  assert.deepStrictEqual(requests, [
    {
      binding: thread.conversationBinding,
      scope: 'thread',
      messageId: decodeMessageId('message-9'),
      messageUrl: undefined,
    },
  ])
})

it('dispatches single-message retrieval by URL', async () => {
  const requests: Array<PlatformMessageGetQuery> = []
  const tool = makePiMessagesTool({
    thread,
    platforms: getStub(requests),
    runPromise: Effect.runPromise,
  })

  // SAFETY: The messages tool does not read ExtensionContext for these operations.
  await tool.execute(
    'call-1',
    { action: 'get', messageUrl: 'https://discord.com/channels/guild/channel/message-9' },
    undefined,
    undefined,
    {} as never,
  )

  assert.deepStrictEqual(requests, [
    {
      binding: thread.conversationBinding,
      scope: 'thread',
      messageId: undefined,
      messageUrl: 'https://discord.com/channels/guild/channel/message-9',
    },
  ])
})

it('rejects get without exactly one of messageUrl or messageId', async () => {
  const tool = makePiMessagesTool({ thread, platforms: neverGet(), runPromise: Effect.runPromise })

  for (const input of [
    { action: 'get', scope: 'thread' },
    { action: 'get', scope: 'thread', messageUrl: '  ' },
    {
      action: 'get',
      scope: 'thread',
      messageUrl: 'https://discord.com/channels/guild/channel/message-9',
      messageId: 'message-9',
    },
  ]) {
    let error: unknown
    try {
      // SAFETY: The messages tool does not read ExtensionContext for these operations.
      await tool.execute('call-1', input, undefined, undefined, {} as never)
    } catch (cause) {
      error = cause
    }
    assert.match(String(error), /exactly one of messageUrl or messageId/)
  }
})
