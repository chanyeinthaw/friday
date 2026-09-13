/* oxlint-disable anti-slop/no-unknown-parameters -- Test doubles mirror the adapter fetch shapes; history payloads are plain test data. */
import { assert, it } from '@effect/vitest'
import { Message } from 'chat'
import * as Effect from 'effect/Effect'

import { projectSlackMessage } from './SlackMessageProjection.ts'
import { loadSlackInitialContext, shouldLoadSlackContext } from './SlackInitialContext.ts'

const inputForChannel = (text = 'hey', ts = '1234567890.999999') =>
  projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts,
    userId: 'U789',
    text,
  })

const inputForThread = () =>
  projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.222222',
    threadTs: '1234567890.111111',
    userId: 'U789',
    text: 'follow up',
  })

const historyMessage = (id: string, text: string, userId = 'U111', bot = false): Message<unknown> =>
  new Message({
    id,
    threadId: 'slack:C456:',
    text,
    formatted: { type: 'root', children: [] },
    raw: { text, user: userId },
    author: { userId, userName: userId, fullName: userId, isBot: bot, isMe: false },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
  })

const historyMessageWithRaw = (
  id: string,
  text: string,
  raw: unknown,
  userId = 'U789',
): Message<unknown> =>
  new Message({
    id,
    threadId: 'slack:C456:',
    text,
    formatted: { type: 'root', children: [] },
    raw,
    author: { userId, userName: userId, fullName: userId, isBot: false, isMe: false },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
  })

interface SeenThreads {
  readonly channel: Array<string>
  readonly thread: Array<string>
}

const seenThreads = (): SeenThreads => ({ channel: [], thread: [] })

const adapterFor = (messages: Array<Message<unknown>>, seen: SeenThreads) => ({
  fetchMessages: (threadId: string, options: { readonly limit: number }) => {
    void options
    seen.thread.push(threadId)
    return Promise.resolve({ messages: [...messages] })
  },
  fetchChannelMessages: (channelId: string, options: { readonly limit: number }) => {
    void options
    seen.channel.push(channelId)
    return Promise.resolve({ messages: [...messages] })
  },
})

it('loads context for new bindings, mention-only invocations, and reply-in-channel transport', () => {
  assert.isTrue(
    shouldLoadSlackContext({
      created: true,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-thread',
    }),
  )
  assert.isTrue(
    shouldLoadSlackContext({
      created: false,
      invocationMode: 'mention-only',
      replyMode: 'reply-in-thread',
    }),
  )
  assert.isTrue(
    shouldLoadSlackContext({
      created: false,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-channel',
    }),
  )
  assert.isFalse(
    shouldLoadSlackContext({
      created: false,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-thread',
    }),
  )
})

it.effect('returns only messages after the proven cursor', () =>
  Effect.gen(function* () {
    const seen = seenThreads()
    const result = yield* loadSlackInitialContext(
      adapterFor(
        [
          historyMessage('msg-1', 'Already ingested.'),
          historyMessage('msg-2', 'Missed one.'),
          historyMessage('msg-3', 'Missed two.'),
        ],
        seen,
      ),
      20,
      inputForChannel(),
      { created: false, afterMessageId: 'msg-1' },
    )
    assert.deepStrictEqual(
      result.initialContext?.map((entry) => entry.content.text),
      ['Missed one.', 'Missed two.'],
    )
  }),
)

it.effect('returns no context when the cursor is absent from the fetched page', () =>
  Effect.gen(function* () {
    const seen = seenThreads()
    const result = yield* loadSlackInitialContext(
      adapterFor(
        [historyMessage('msg-2', 'Unproven message.'), historyMessage('msg-3', 'Also unproven.')],
        seen,
      ),
      20,
      inputForChannel(),
      { created: false, afterMessageId: 'msg-before' },
    )
    assert.deepStrictEqual(result.initialContext, [])
  }),
)

it.effect('skips bots and the triggering message while keeping the 8k bound', () =>
  Effect.gen(function* () {
    const seen = seenThreads()
    const triggerTs = '1234567890.999999'
    const result = yield* loadSlackInitialContext(
      adapterFor(
        [
          historyMessage('msg-1', 'Keep me.'),
          historyMessage('msg-bot', 'Friday output.', 'U999', true),
          historyMessageWithRaw(triggerTs, 'trigger text', {
            text: 'trigger text',
            user: 'U789',
          }),
        ],
        seen,
      ),
      20,
      inputForChannel('hey', triggerTs),
      { created: true },
    )
    assert.deepStrictEqual(
      result.initialContext?.map((entry) => entry.content.text),
      ['Keep me.'],
    )
  }),
)

it.effect('reads thread history for thread-scoped inputs and channel history otherwise', () =>
  Effect.gen(function* () {
    const threadSeen = seenThreads()
    yield* loadSlackInitialContext(
      adapterFor([historyMessage('msg-1', 'Thread discussion.')], threadSeen),
      20,
      inputForThread(),
      { created: true },
    )
    assert.strictEqual(threadSeen.thread[0], 'slack:C456:1234567890.111111')
    assert.strictEqual(threadSeen.channel.length, 0)

    const channelSeen = seenThreads()
    yield* loadSlackInitialContext(
      adapterFor([historyMessage('msg-1', 'Channel discussion.')], channelSeen),
      20,
      inputForChannel(),
      { created: true },
    )
    assert.strictEqual(channelSeen.channel[0], 'slack:C456')
    assert.strictEqual(channelSeen.thread.length, 0)
  }),
)
