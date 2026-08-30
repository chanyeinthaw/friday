import { assert, it } from '@effect/vitest'
import { ChannelThread } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { makePiMessagesTool } from './PiMessagesTool.ts'

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

it('dispatches bounded thread search through the current binding', async () => {
  const requests: Array<unknown> = []
  const tool = makePiMessagesTool({
    thread,
    platforms: {
      searchMessages: (request) =>
        Effect.sync(() => {
          requests.push(request)
          return { messages: [], scannedCount: 12, truncated: false }
        }),
    },
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

  assert.strictEqual(requests.length, 1)
  assert.deepStrictEqual(requests[0], {
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
  const tool = makePiMessagesTool({
    thread,
    platforms: { searchMessages: () => Effect.die('should not run') },
    runPromise: Effect.runPromise,
  })

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
