import { assert, it } from '@effect/vitest'
import { ConversationBinding, PlatformMessageId } from '@friday/contracts/conversation'
import { Message } from 'chat'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  compareSlackMessageTs,
  getSlackMessage,
  postSlackMessage,
  searchSlackMessages,
  SlackMaxPostLength,
  type SlackMessageQueryAdapter,
  type SlackMessageQueryPolicy,
} from './SlackMessageSearch.ts'
import {
  PlatformMessageNotFoundError,
  PlatformTargetNotFoundError,
  type SlackQueryTarget,
} from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'slack',
  connectionId: 'slack',
  channelId: 'slack:T123:C456',
  sourceMessageId: '1234567890.111111',
  conversationId: 'slack:T123:C456',
})
const decodeMessageId = Schema.decodeSync(PlatformMessageId)
const isTargetNotFound = Schema.is(PlatformTargetNotFoundError)
const isMessageNotFound = Schema.is(PlatformMessageNotFoundError)
const isPublicationError = Schema.is(ChatSdkPublicationError)

const slackMessage = (
  id: string,
  text: string,
  userId = 'U123',
  raw: {
    readonly thread_ts?: string
    readonly user?: string
    readonly bot_id?: string
    readonly subtype?: string
  } = {},
) =>
  new Message({
    id,
    threadId: `slack:C456:${id}`,
    text,
    formatted: { type: 'root', children: [] },
    raw: { text, user: userId, ...raw },
    author: { userId, userName: userId, fullName: userId, isBot: false, isMe: false },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
  })

const botMessage = (id: string, text: string) =>
  new Message({
    id,
    threadId: `slack:C456:${id}`,
    text,
    formatted: { type: 'root', children: [] },
    raw: { text, bot_id: 'B123', subtype: 'bot_message' },
    author: { userId: '', userName: 'bot', fullName: 'bot', isBot: true, isMe: false },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
  })

const policyFor = (workspaceId = 'T123'): SlackMessageQueryPolicy => ({
  workspaceId,
})

const channelTarget = (teamId = 'T123', channelId = 'C456'): SlackQueryTarget => ({
  platform: 'slack',
  workspaceId: teamId,
  channelId,
})

const threadTarget = (threadTs: string, channelId = 'C456', teamId = 'T123'): SlackQueryTarget => ({
  platform: 'slack',
  workspaceId: teamId,
  channelId,
  threadTs,
})

interface StubOptions {
  readonly channelPages?: ReadonlyArray<ReadonlyArray<Message>>
  readonly threadPages?: ReadonlyArray<ReadonlyArray<Message>>
  readonly direct?: (threadId: string, messageId: string) => Promise<Message | null>
  readonly posted?: Array<{ readonly address: string; readonly text: string }>
  readonly postId?: string | null
}

const stubAdapter = (
  options: StubOptions = {},
): SlackMessageQueryAdapter & {
  readonly seen: Array<{
    readonly kind: string
    readonly address: string
    readonly cursor?: string
  }>
} => {
  const seen: Array<{ readonly kind: string; readonly address: string; readonly cursor?: string }> =
    []
  let channelPage = 0
  let threadPage = 0
  return {
    seen,
    fetchChannelMessages: (channelId: string, fetchOptions?: { readonly cursor?: string }) => {
      const cursor = fetchOptions?.cursor
      seen.push(
        cursor === undefined
          ? { kind: 'channel', address: channelId }
          : { kind: 'channel', address: channelId, cursor },
      )
      const messages = options.channelPages?.[channelPage++] ?? []
      const nextCursor =
        options.channelPages !== undefined && channelPage < options.channelPages.length
          ? `cursor-${channelPage}`
          : undefined
      return Promise.resolve(
        nextCursor === undefined
          ? { messages: [...messages] }
          : { messages: [...messages], nextCursor },
      )
    },
    fetchMessages: (threadId: string, fetchOptions?: { readonly cursor?: string }) => {
      const cursor = fetchOptions?.cursor
      seen.push(
        cursor === undefined
          ? { kind: 'thread', address: threadId }
          : { kind: 'thread', address: threadId, cursor },
      )
      const messages = options.threadPages?.[threadPage++] ?? []
      const nextCursor =
        options.threadPages !== undefined && threadPage < options.threadPages.length
          ? `cursor-${threadPage}`
          : undefined
      return Promise.resolve(
        nextCursor === undefined
          ? { messages: [...messages] }
          : { messages: [...messages], nextCursor },
      )
    },
    fetchMessage: options.direct ?? (() => Promise.resolve(null)),
    postMessage: (address: string, text: string) => {
      options.posted?.push({ address, text })
      return Promise.resolve({ id: options.postId ?? '300.3', threadId: address, raw: {} })
    },
    postChannelMessage: (address: string, text: string) => {
      options.posted?.push({ address, text })
      return Promise.resolve({ id: options.postId ?? '300.3', threadId: address, raw: {} })
    },
  }
}

it('orders Slack timestamps without float precision loss', () => {
  assert.isBelow(compareSlackMessageTs('100.1', '200.2'), 0)
  assert.isAbove(compareSlackMessageTs('200.2', '100.1'), 0)
  assert.strictEqual(compareSlackMessageTs('200.2', '200.2'), 0)
  assert.isBelow(compareSlackMessageTs('1234567890.123455', '1234567890.123456'), 0)
  assert.isBelow(compareSlackMessageTs('999.999999', '1000.000000'), 0)
})

it.effect('rejects cross-workspace targets before policy lookup or any adapter call', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelPages: [[slackMessage('100.1', 'deploy pipeline notes')]],
    })
    // Even though the channel policy would admit T999:C789, the connection
    // is bound to T123, so the mismatched workspace fails closed first.
    const error = yield* searchSlackMessages(
      adapter,
      { binding, target: channelTarget('T999', 'C789'), query: 'deploy', limit: 10 },
      policyFor(),
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
    assert.strictEqual(error.message, 'Target not found or not accessible.')
    assert.deepStrictEqual(adapter.seen, [])
  }),
)

it.effect('searches a matching-workspace channel target on this connection', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelPages: [[slackMessage('100.1', 'deploy pipeline notes')]],
    })
    const result = yield* searchSlackMessages(
      adapter,
      { binding, target: channelTarget('T123', 'C456'), query: 'deploy', limit: 10 },
      policyFor(),
    )

    assert.deepStrictEqual(
      adapter.seen.map(({ kind, address }) => `${kind}:${address}`),
      ['channel:slack:C456'],
    )
    assert.strictEqual(result.messages.length, 1)
    assert.strictEqual(result.messages[0]?.text, 'deploy pipeline notes')
    assert.strictEqual(result.messages[0]?.author.platformUserId, 'U123')
  }),
)

it.effect('searches a thread target through the native thread', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      threadPages: [[slackMessage('111.2', 'thread reply here')]],
    })
    const result = yield* searchSlackMessages(
      adapter,
      { binding, target: threadTarget('111.1'), limit: 10 },
      policyFor(),
    )

    assert.deepStrictEqual(
      adapter.seen.map(({ kind, address }) => `${kind}:${address}`),
      ['thread:slack:C456:111.1'],
    )
    assert.strictEqual(result.messages.length, 1)
  }),
)

it.effect('keeps bot filtering while preserving limits', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelPages: [[botMessage('100.1', 'bot noise'), slackMessage('100.2', 'human note')]],
    })
    const result = yield* searchSlackMessages(
      adapter,
      { binding, target: channelTarget(), limit: 10 },
      policyFor(),
    )

    assert.strictEqual(result.messages.length, 1)
    assert.strictEqual(result.messages[0]?.id, '100.2')
    assert.strictEqual(result.scannedCount, 2)
  }),
)

it.effect('treats before as an ordering boundary rather than an API cursor', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      // The transport ignores cursors here; every returned message at or
      // after `before` must still be excluded by the boundary filter.
      channelPages: [
        [
          slackMessage('300.3', 'newest'),
          slackMessage('200.2', 'boundary'),
          slackMessage('100.1', 'wanted'),
        ],
      ],
    })
    const result = yield* searchSlackMessages(
      adapter,
      {
        binding,
        target: channelTarget(),
        limit: 10,
        before: decodeMessageId('200.2'),
      },
      policyFor(),
    )

    assert.strictEqual(adapter.seen[0]?.cursor, undefined)
    assert.deepStrictEqual(
      result.messages.map((record) => String(record.id)),
      ['100.1'],
    )
  }),
)

it.effect('applies the before boundary across paginated results', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelPages: [
        [slackMessage('400.4', 'newest')],
        [slackMessage('100.1', 'wanted'), slackMessage('200.2', 'boundary')],
      ],
    })
    const result = yield* searchSlackMessages(
      adapter,
      { binding, target: channelTarget(), limit: 10, before: decodeMessageId('200.2') },
      policyFor(),
    )

    assert.deepStrictEqual(
      result.messages.map((record) => String(record.id)),
      ['100.1'],
    )
  }),
)

it.effect('searches visible channels regardless of admission config', () =>
  Effect.gen(function* () {
    const result = yield* searchSlackMessages(
      stubAdapter({ channelPages: [[slackMessage('100.1', 'secret')]] }),
      { binding, target: channelTarget('T123', 'C999'), limit: 10 },
      policyFor(),
    )

    assert.strictEqual(result.messages.length, 1)
    assert.strictEqual(result.messages[0]?.text, 'secret')
  }),
)

it.effect('fetches a channel message as its own thread root', () =>
  Effect.gen(function* () {
    const calls: Array<[string, string]> = []
    const adapter = stubAdapter({
      direct: (threadId, messageId) => {
        calls.push([threadId, messageId])
        return Promise.resolve(slackMessage(messageId, 'hello channel'))
      },
    })
    const result = yield* getSlackMessage(
      adapter,
      { binding, target: channelTarget(), messageId: decodeMessageId('200.2') },
      policyFor(),
    )

    assert.deepStrictEqual(calls, [['slack:C456:200.2', '200.2']])
    assert.strictEqual(result.message.text, 'hello channel')
    assert.strictEqual(result.message.replyToMessageId, null)
  }),
)

it.effect('fetches a thread message within its native thread', () =>
  Effect.gen(function* () {
    const calls: Array<[string, string]> = []
    const adapter = stubAdapter({
      direct: (threadId, messageId) => {
        calls.push([threadId, messageId])
        return Promise.resolve(
          slackMessage(messageId, 'hello thread', 'U456', { thread_ts: '111.1' }),
        )
      },
    })
    const result = yield* getSlackMessage(
      adapter,
      { binding, target: threadTarget('111.1'), messageId: decodeMessageId('222.2') },
      policyFor(),
    )

    assert.deepStrictEqual(calls, [['slack:C456:111.1', '222.2']])
    assert.strictEqual(result.message.replyToMessageId, '111.1')
  }),
)

it.effect('preserves bot authors through direct get', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      direct: (_threadId, messageId) => Promise.resolve(botMessage(messageId, 'beep')),
    })
    const result = yield* getSlackMessage(
      adapter,
      { binding, target: channelTarget(), messageId: decodeMessageId('200.2') },
      policyFor(),
    )

    assert.strictEqual(result.message.text, 'beep')
  }),
)

it.effect(
  'collapses missing and mismatched gets to a generic not-found, keeps visible channels',
  () =>
    Effect.gen(function* () {
      const missing = stubAdapter({ direct: () => Promise.resolve(null) })
      const policy = policyFor()
      for (const query of [
        {
          binding,
          target: channelTarget(),
          messageId: decodeMessageId('999.9'),
        },
        { binding, messageId: decodeMessageId('200.2') },
        {
          binding,
          target: channelTarget(),
          messageUrl: 'https://example.slack.com/archives/C456/p123',
        },
      ]) {
        const error = yield* getSlackMessage(missing, query, policy).pipe(Effect.flip)
        assert(isMessageNotFound(error))
        assert.strictEqual(error.message, 'Message not found.')
      }
      const visible = yield* getSlackMessage(
        stubAdapter({ direct: () => Promise.resolve(slackMessage('200.2', 'secret')) }),
        { binding, target: channelTarget('T123', 'C999'), messageId: decodeMessageId('200.2') },
        policy,
      )
      assert.strictEqual(visible.message.text, 'secret')
    }),
)

it.effect('collapses cross-workspace gets to a generic not-found without adapter calls', () =>
  Effect.gen(function* () {
    const calls: Array<[string, string]> = []
    const adapter = stubAdapter({
      direct: (threadId, messageId) => {
        calls.push([threadId, messageId])
        return Promise.resolve(slackMessage(messageId, 'other workspace'))
      },
    })
    const error = yield* getSlackMessage(
      adapter,
      { binding, target: channelTarget('T999', 'C789'), messageId: decodeMessageId('200.2') },
      policyFor(),
    ).pipe(Effect.flip)

    assert(isMessageNotFound(error))
    assert.strictEqual(error.message, 'Message not found.')
    assert.deepStrictEqual(calls, [])
  }),
)

it.effect('posts top-level to a channel target and returns the native timestamp id', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    const result = yield* postSlackMessage(
      stubAdapter({ posted, postId: '400.4' }),
      { binding, target: channelTarget(), text: 'hello channel' },
      policyFor(),
    )

    assert.deepStrictEqual(posted, [{ address: 'slack:C456', text: 'hello channel' }])
    assert.strictEqual(result.messageId, '400.4')
  }),
)

it.effect('posts a thread reply for a thread target', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    yield* postSlackMessage(
      stubAdapter({ posted }),
      { binding, target: threadTarget('111.1'), text: 'hello thread' },
      policyFor(),
    )

    assert.deepStrictEqual(posted, [{ address: 'slack:C456:111.1', text: 'hello thread' }])
  }),
)

it.effect('posts to visible DM channels through the API', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    const adapter = stubAdapter({ posted })
    yield* postSlackMessage(
      adapter,
      { binding, target: channelTarget('T123', 'D123'), text: 'hello dm' },
      policyFor(),
    )
    assert.deepStrictEqual(posted, [{ address: 'slack:D123', text: 'hello dm' }])

    yield* postSlackMessage(
      adapter,
      { binding, target: channelTarget('T123', 'D999'), text: 'hello dm' },
      policyFor(),
    )
    assert.strictEqual(posted.length, 2)
  }),
)

it.effect('rejects cross-workspace posts before policy lookup or any adapter call', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    const adapter = stubAdapter({ posted })
    const error = yield* postSlackMessage(
      adapter,
      { binding, target: channelTarget('T999', 'C789'), text: 'hello other' },
      policyFor(),
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
    assert.strictEqual(error.message, 'Target not found or not accessible.')
    assert.deepStrictEqual(posted, [])
    assert.deepStrictEqual(adapter.seen, [])
  }),
)

it.effect('rejects empty and over-limit Slack posts without posting', () =>
  Effect.gen(function* () {
    const posted: Array<{ readonly address: string; readonly text: string }> = []
    const adapter = stubAdapter({ posted })
    const policy = policyFor()

    const empty = yield* postSlackMessage(
      adapter,
      { binding, target: channelTarget(), text: '  ' },
      policy,
    ).pipe(Effect.flip)
    assert(isPublicationError(empty))

    const over = yield* postSlackMessage(
      adapter,
      { binding, target: channelTarget(), text: 'x'.repeat(SlackMaxPostLength + 1) },
      policy,
    ).pipe(Effect.flip)
    assert(isPublicationError(over))
    assert.deepStrictEqual(posted, [])
  }),
)

it.effect('returns a null id when the transport exposes none', () =>
  Effect.gen(function* () {
    const adapter: SlackMessageQueryAdapter = {
      ...stubAdapter(),
      postChannelMessage: () => Promise.resolve({ id: '', threadId: 'x', raw: {} }),
    }
    const result = yield* postSlackMessage(
      adapter,
      { binding, target: channelTarget(), text: 'hello' },
      policyFor(),
    )

    assert.strictEqual(result.messageId, null)
  }),
)

const slackPostError = (code: string) => ({ data: { error: code } })

it.effect('maps inaccessible post channels to not-found with the read codes', () =>
  Effect.gen(function* () {
    for (const code of [
      'channel_not_found',
      'not_in_channel',
      'restricted_action',
      'action_not_allowed',
    ]) {
      const posted: Array<{ readonly address: string; readonly text: string }> = []
      const adapter: SlackMessageQueryAdapter = {
        ...stubAdapter({ posted }),
        postChannelMessage: () => Promise.reject(slackPostError(code)),
      }
      const error = yield* postSlackMessage(
        adapter,
        { binding, target: channelTarget(), text: 'hello' },
        policyFor(),
      ).pipe(Effect.flip)
      assert(isTargetNotFound(error), `expected not-found for ${code}`)
      assert.strictEqual(error.message, 'Target not found or not accessible.')
      assert.deepStrictEqual(posted, [])
    }
  }),
)

it.effect('maps inaccessible thread replies to not-found', () =>
  Effect.gen(function* () {
    const adapter: SlackMessageQueryAdapter = {
      ...stubAdapter(),
      postMessage: () => Promise.reject(slackPostError('not_in_channel')),
    }
    const error = yield* postSlackMessage(
      adapter,
      { binding, target: threadTarget('111.1'), text: 'hello thread' },
      policyFor(),
    ).pipe(Effect.flip)
    assert(isTargetNotFound(error))
  }),
)

it.effect('keeps transport and other post failures as publication errors', () =>
  Effect.gen(function* () {
    for (const code of ['rate_limited', 'invalid_auth', 'unknown_method']) {
      const adapter: SlackMessageQueryAdapter = {
        ...stubAdapter(),
        postChannelMessage: () => Promise.reject(slackPostError(code)),
      }
      const error = yield* postSlackMessage(
        adapter,
        { binding, target: channelTarget(), text: 'hello' },
        policyFor(),
      ).pipe(Effect.flip)
      assert(isPublicationError(error), `expected publication error for ${code}`)
    }
    const networkAdapter: SlackMessageQueryAdapter = {
      ...stubAdapter(),
      postChannelMessage: () => Promise.reject(new Error('socket hang up')),
    }
    const networkError = yield* postSlackMessage(
      networkAdapter,
      { binding, target: channelTarget(), text: 'hello' },
      policyFor(),
    ).pipe(Effect.flip)
    assert(isPublicationError(networkError))
  }),
)
