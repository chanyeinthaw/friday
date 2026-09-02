/* oxlint-disable anti-slop/no-unknown-parameters -- The stub mirrors the adapter's declared Discord HTTP-boundary signatures; recording the raw calls is the point of the test double. */

import type { FridayDiscordAdapter } from './FridayDiscordAdapter.ts'
import { assert, it } from '@effect/vitest'
import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { DiscordLinkSourceEndpoint } from '../../config/DiscordLinks.ts'
import { makeDiscordCapability } from './DiscordLinkedRuntime.ts'

const decodeEndpoint = Schema.decodeSync(DiscordLinkSourceEndpoint)
const connectionId = Schema.decodeSync(PlatformConnectionId)('discord-source')

const channelEndpoint = decodeEndpoint({
  connectionId: 'discord-source',
  guildId: '11111111111111111',
  conversationId: '22222222222222222',
  kind: 'channel',
})
const threadEndpoint = decodeEndpoint({
  connectionId: 'discord-source',
  guildId: '11111111111111111',
  conversationId: '33333333333333333',
  kind: 'thread',
})

const message = (id: string, text: string) => ({
  id,
  text,
  author: { userId: '66666666666666666', userName: 'pat', fullName: 'Pat' },
  metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
  attachments: [],
})

interface RecordedFetch {
  readonly threadId: string
  readonly limit: number | undefined
  readonly cursor: string | undefined
}

interface RecordedApiCall {
  readonly path: string
  readonly method: string
  readonly body: unknown
}

/**
 * Builds a capability over a recording adapter stub so tests observe exactly
 * which Discord calls the trigger fetch makes and how the results merge.
 */
const makeCapability = (options: {
  readonly history: ReadonlyArray<ReturnType<typeof message>>
  readonly trigger?: ReturnType<typeof message>
}) => {
  const historyFetches: Array<RecordedFetch> = []
  const triggerFetches: Array<{ readonly threadId: string; readonly messageId: string }> = []
  const apiCalls: Array<RecordedApiCall> = []
  // SAFETY: makeDiscordCapability only calls the adapter methods defined by
  // this recording stub in these fetch-context tests.
  const stub: FridayDiscordAdapter = {
    encodeThreadId: (location: { guildId: string; channelId: string; threadId?: string }) =>
      [location.guildId, location.channelId, location.threadId].filter(Boolean).join(':'),
    fetchMessages: async (threadId: string, fetchOptions: { limit?: number; cursor?: string }) => {
      historyFetches.push({
        threadId,
        limit: fetchOptions?.limit,
        cursor: fetchOptions?.cursor,
      })
      // SAFETY: the capability reads only the Message fields produced by the
      // message helper above.
      return { messages: options.history } as never
    },
    fridayFetchMessage: async (threadId: string, messageId: string) => {
      triggerFetches.push({ threadId, messageId })
      // SAFETY: the capability only reads the chat Message fields rendered below.
      return (options.trigger ??
        message('55555555555555555', 'Friday, please take this over.')) as never
    },
    fridayDiscordRequest: async (path: string, method: string, body?: unknown) => {
      apiCalls.push({ path, method, body })
      return new Response('{"id":"77777777777777777"}', { status: 200 })
    },
  } as never
  return {
    capability: makeDiscordCapability(connectionId, stub),
    historyFetches,
    triggerFetches,
    apiCalls,
  }
}

it.effect('fetches the trigger directly by message ID alongside bounded prior history', () =>
  Effect.gen(function* () {
    const { capability, historyFetches, triggerFetches } = makeCapability({
      history: [message('44444444444444440', 'older message')],
    })

    const messages = yield* capability.fetchContext(channelEndpoint, '55555555555555555', 20)

    // The trigger is fetched directly, not trusted to appear in history scans.
    assert.deepStrictEqual(triggerFetches, [
      { threadId: '11111111111111111:22222222222222222', messageId: '55555555555555555' },
    ])
    // The history page is bounded to one less than the limit and anchored
    // before the trigger message.
    assert.deepStrictEqual(historyFetches, [
      {
        threadId: '11111111111111111:22222222222222222',
        limit: 19,
        cursor: '55555555555555555',
      },
    ])
    assert.deepStrictEqual(
      messages.map((sourceMessage) => sourceMessage.id),
      ['44444444444444440', '55555555555555555'],
    )
  }),
)

it.effect('posts only to the bound source with exact allowed mentions', () =>
  Effect.gen(function* () {
    const { capability, apiCalls } = makeCapability({ history: [] })

    const result = yield* capability.postSafe(
      channelEndpoint,
      '<@66666666666666666> status update',
      ['66666666666666666'],
    )

    assert.deepStrictEqual(result, { messageId: '77777777777777777' })
    assert.deepStrictEqual(apiCalls, [
      {
        path: '/channels/22222222222222222/messages',
        method: 'POST',
        body: {
          content: '<@66666666666666666> status update',
          allowed_mentions: {
            parse: [],
            users: ['66666666666666666'],
            roles: [],
            replied_user: false,
          },
        },
      },
    ])
  }),
)

it.effect('resolves a thread endpoint to the thread conversation', () =>
  Effect.gen(function* () {
    const { capability, historyFetches, triggerFetches } = makeCapability({ history: [] })

    yield* capability.fetchContext(threadEndpoint, '55555555555555555', 5)

    assert.deepStrictEqual(
      triggerFetches[0]!.threadId,
      '11111111111111111:33333333333333333:33333333333333333',
    )
    assert.deepStrictEqual(
      historyFetches[0]!.threadId,
      '11111111111111111:33333333333333333:33333333333333333',
    )
  }),
)

it.effect('keeps the trigger even when delayed history scans miss it', () =>
  Effect.gen(function* () {
    // A delayed consumer redelivers long after the original message; the
    // bounded history window no longer contains the trigger.
    const { capability } = makeCapability({ history: [] })

    const messages = yield* capability.fetchContext(channelEndpoint, '55555555555555555', 20)

    assert.deepStrictEqual(
      messages.map((sourceMessage) => sourceMessage.id),
      ['55555555555555555'],
    )
  }),
)

it.effect('deduplicates messages the history page repeats deterministically', () =>
  Effect.gen(function* () {
    // The history window still contains the trigger itself; the merge must not
    // duplicate it and the direct fetch stays authoritative.
    const { capability } = makeCapability({
      history: [
        message('44444444444444440', 'older message'),
        message('55555555555555555', 'stale history copy'),
      ],
      trigger: message('55555555555555555', 'Friday, please take this over.'),
    })

    const messages = yield* capability.fetchContext(channelEndpoint, '55555555555555555', 20)

    assert.deepStrictEqual(
      messages.map((sourceMessage) => sourceMessage.id),
      ['44444444444444440', '55555555555555555'],
    )
    assert.deepStrictEqual(
      messages.find((sourceMessage) => sourceMessage.id === '55555555555555555')?.text,
      'Friday, please take this over.',
    )
  }),
)
