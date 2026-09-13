import {
  ConversationBinding,
  PlatformConnectionId,
  PlatformMessageId,
  TaskId,
} from '@friday/contracts/conversation'
import { assert, it } from '@effect/vitest'
import { Message } from 'chat'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import { makeSlackPlatform, SlackMaxMessageLength } from './SlackPlatform.ts'

const isPublicationError = Schema.is(ChatSdkPublicationError)

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeTaskId = Schema.decodeUnknownSync(TaskId)

const connectionId = decodeConnectionId('slack-personal')

const channelBinding = decodeBinding({
  platform: 'slack',
  connectionId: 'slack-personal',
  channelId: 'slack:T123:C456',
  sourceMessageId: '1234567890.111111',
  conversationId: 'slack:T123:C456',
  scopeId: 'T123',
})

const threadBinding = decodeBinding({
  platform: 'slack',
  connectionId: 'slack-personal',
  channelId: 'slack:T123:C456',
  sourceMessageId: '1234567890.222222',
  conversationId: 'slack:T123:C456:1234567890.111111',
  scopeId: 'T123',
})

interface PostedCall {
  readonly threadId: string
  readonly text: string
}

const messageWithId = (id: string, threadId: string, text?: string): Message<unknown> =>
  new Message({
    id,
    threadId,
    text: text ?? id,
    formatted: { type: 'root', children: [] },
    raw: {},
    author: { userId: 'U123', userName: 'user', fullName: 'User', isBot: false, isMe: false },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
  })

const makeFakeAdapter = () => {
  const posted: Array<PostedCall> = []
  const edited: Array<{
    readonly threadId: string
    readonly messageId: string
    readonly text: string
  }> = []
  const deleted: Array<{ readonly threadId: string; readonly messageId: string }> = []
  const reactions: Array<{
    readonly threadId: string
    readonly messageId: string
    readonly emoji: string
  }> = []
  const titles: Array<{
    readonly channel: string
    readonly threadTs: string
    readonly title: string
  }> = []
  const fetchOptions: Array<{ readonly limit?: number | undefined }> = []
  const channelHistory: Array<Message<unknown>> = []
  const threadHistory: Array<Message<unknown>> = []
  let counter = 0
  const historyForPost = (threadId: string): Array<Message<unknown>> =>
    threadId === 'slack:C456:' ? channelHistory : threadHistory
  const adapter = {
    postMessage: (threadId: string, text: string) =>
      Promise.resolve().then(() => {
        counter += 1
        const id = `1234567890.90000${counter}`
        posted.push({ threadId, text })
        historyForPost(threadId).push(messageWithId(id, threadId, text))
        return { id, threadId, raw: {} }
      }),
    editMessage: (threadId: string, messageId: string, text: string) =>
      Promise.resolve().then(() => {
        edited.push({ threadId, messageId, text })
        return { id: messageId, threadId, raw: {} }
      }),
    deleteMessage: (threadId: string, messageId: string) =>
      Promise.resolve().then(() => {
        deleted.push({ threadId, messageId })
      }),
    addReaction: (threadId: string, messageId: string, emoji: string) =>
      Promise.resolve().then(() => {
        reactions.push({ threadId, messageId, emoji })
      }),
    setAssistantTitle: (channel: string, threadTs: string, title: string) =>
      Promise.resolve().then(() => {
        titles.push({ channel, threadTs, title })
      }),
    fetchMessages: (threadId: string, options?: { readonly limit?: number }) =>
      Promise.resolve().then(() => {
        fetchOptions.push({ limit: options?.limit })
        return { messages: threadHistory.slice(-(options?.limit ?? 1)) }
      }),
    fetchChannelMessages: (channelId: string, options?: { readonly limit?: number }) =>
      Promise.resolve().then(() => {
        fetchOptions.push({ limit: options?.limit })
        return { messages: channelHistory.slice(-(options?.limit ?? 1)) }
      }),
  }
  const overtakeChannel = (id: string): void => {
    channelHistory.push(messageWithId(id, 'slack:C456:'))
  }
  const overtakeThread = (id: string): void => {
    threadHistory.push(messageWithId(id, 'slack:C456:1234567890.111111'))
  }
  const clearHistories = (): void => {
    channelHistory.length = 0
    threadHistory.length = 0
  }
  return {
    adapter,
    posted,
    edited,
    deleted,
    reactions,
    titles,
    fetchOptions,
    overtakeChannel,
    overtakeThread,
    clearHistories,
  }
}

const assertNoNativeStatus = (fake: ReturnType<typeof makeFakeAdapter>): void => {
  assert.isFalse('startTyping' in fake.adapter)
  assert.isFalse('endTyping' in fake.adapter)
  assert.isFalse('setSessionStatus' in fake.adapter)
  assert.isFalse('setAssistantStatus' in fake.adapter)
}

it.effect('publishes channels and threads through reconciled adapter ids', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)
    yield* platform.publish({ binding: channelBinding, text: 'hello' })
    yield* platform.publish({ binding: threadBinding, text: 'reply' })
    assert.strictEqual(fake.posted[0]?.threadId, 'slack:C456:')
    assert.strictEqual(fake.posted[1]?.threadId, 'slack:C456:1234567890.111111')
  }),
)

it.effect('chunks long publications and edits visible working messages', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)
    const text = `line\n${'word '.repeat(2000)}`
    assert.ok(text.length > SlackMaxMessageLength)
    yield* platform.publish({ binding: channelBinding, text })
    assert.ok(fake.posted.length > 1)
    yield* platform.beginWorking({ binding: channelBinding, text: 'working…' })
    yield* platform.updateWorking({ binding: channelBinding, text: 'still working…' })
    assert.strictEqual(fake.edited.length, 1)
    assert.strictEqual(fake.edited[0]?.text, 'still working…')
    yield* platform.finalizeWorking({ binding: channelBinding, text: 'done' })
    assertNoNativeStatus(fake)
  }),
)

it.effect('acknowledges, titles threads only, and passes typing through', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)
    yield* platform.acknowledge({
      binding: channelBinding,
      messageId: decodeMessageId('1234567890.111111'),
    })
    assert.strictEqual(platform.kind, 'slack')
    assert.strictEqual(fake.reactions.length, 1)
    assert.strictEqual(fake.reactions[0]?.emoji, 'eyes')
    yield* platform.setConversationTitle({ binding: channelBinding, title: 'ignored' })
    assert.strictEqual(fake.titles.length, 0)
    yield* platform.setConversationTitle({ binding: threadBinding, title: '  Deploy work  ' })
    assert.strictEqual(fake.titles.length, 1)
    assert.strictEqual(fake.titles[0]?.channel, 'C456')
    assert.strictEqual(fake.titles[0]?.title, 'Deploy work')
    yield* platform.setConversationTitle({
      binding: threadBinding,
      title: `Deploy ${'plan '.repeat(40)}`,
    })
    assert.strictEqual(fake.titles[1]?.title.length, 80)
    yield* platform.setConversationTitle({ binding: threadBinding, title: '   ' })
    assert.strictEqual(fake.titles.length, 2)
    yield* platform.setAgentActivity({
      binding: channelBinding,
      taskId: decodeTaskId('task-1'),
      active: true,
    })
    const typed = yield* platform.withTyping(channelBinding, Effect.succeed('typed'))
    assert.strictEqual(typed, 'typed')
    const postedBefore = fake.posted.length
    const editedBefore = fake.edited.length
    const deletedBefore = fake.deleted.length
    yield* platform.withTyping(channelBinding, Effect.void)
    assert.strictEqual(fake.posted.length, postedBefore)
    assert.strictEqual(fake.edited.length, editedBefore)
    assert.strictEqual(fake.deleted.length, deletedBefore)
    assertNoNativeStatus(fake)
  }),
)

it.effect('discards working messages best-effort', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)
    yield* platform.beginWorking({ binding: channelBinding, text: 'working…' })
    yield* platform.discardWorking(channelBinding)
    assert.strictEqual(fake.deleted.length, 1)
    yield* platform.discardWorking(channelBinding)
    assert.strictEqual(fake.deleted.length, 1)
    assertNoNativeStatus(fake)
  }),
)

it.effect('keeps plain working messages without Discord decoration', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)

    yield* platform.beginWorking({ binding: channelBinding, text: 'Thinking...' })
    yield* platform.updateWorking({ binding: channelBinding, text: 'Reading files...' })
    yield* platform.finalizeWorking({ binding: channelBinding, text: 'Final answer.' })

    assert.strictEqual(fake.posted.length, 1)
    assert.strictEqual(fake.posted[0]?.text, 'Thinking...')
    assert.strictEqual(fake.posted[0]?.threadId, 'slack:C456:')
    assert.strictEqual(fake.edited.length, 2)
    assert.strictEqual(fake.edited[0]?.text, 'Reading files...')
    assert.strictEqual(fake.edited[1]?.text, 'Final answer.')
    assert.strictEqual(fake.deleted.length, 0)
    assertNoNativeStatus(fake)
  }),
)

it.effect('deletes an overtaken working message and posts fresh at the bottom', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)

    yield* platform.beginWorking({ binding: channelBinding, text: 'Thinking...' })
    fake.overtakeChannel('1234567890.222222')
    yield* platform.finalizeWorking({ binding: channelBinding, text: 'Final answer.' })

    assert.strictEqual(fake.posted.length, 2)
    assert.strictEqual(fake.posted[1]?.text, 'Final answer.')
    assert.strictEqual(fake.edited.length, 0)
    assert.strictEqual(fake.deleted.length, 1)
    assertNoNativeStatus(fake)
    // The latest check reads exactly one channel message.
    assert.deepStrictEqual(fake.fetchOptions, [{ limit: 1 }])
  }),
)

it.effect('deletes an overtaken thread working message and posts fresh', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)

    yield* platform.beginWorking({ binding: threadBinding, text: 'Thinking...' })
    fake.overtakeThread('1234567890.333333')
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Thread done.' })

    assert.strictEqual(fake.posted.length, 2)
    assert.strictEqual(fake.posted[1]?.threadId, 'slack:C456:1234567890.111111')
    assert.strictEqual(fake.deleted.length, 1)
    assertNoNativeStatus(fake)
  }),
)

it.effect('splits a long final answer after editing the latest working message', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)
    const text = `line\n${'word '.repeat(2000)}`
    assert.ok(text.length > SlackMaxMessageLength)

    yield* platform.beginWorking({ binding: channelBinding, text: 'Thinking...' })
    const postedBefore = fake.posted.length
    yield* platform.finalizeWorking({ binding: channelBinding, text })

    assert.strictEqual(fake.deleted.length, 0)
    assert.strictEqual(fake.edited.length, 1)
    assert.ok(fake.posted.length > postedBefore + 1)
    assertNoNativeStatus(fake)
  }),
)

it.effect('splits a long final answer after deleting a stale working message', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)
    const text = `line\n${'word '.repeat(2000)}`
    assert.ok(text.length > SlackMaxMessageLength)

    yield* platform.beginWorking({ binding: channelBinding, text: 'Thinking...' })
    fake.overtakeChannel('1234567890.222222')
    const postedBefore = fake.posted.length
    yield* platform.finalizeWorking({ binding: channelBinding, text })

    assert.strictEqual(fake.deleted.length, 1)
    assert.strictEqual(fake.edited.length, 0)
    assert.ok(fake.posted.length > postedBefore + 1)
    assertNoNativeStatus(fake)
  }),
)

it.effect('keeps long visible statuses without native status calls', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)

    yield* platform.beginWorking({ binding: channelBinding, text: 'Thinking...' })
    assert.strictEqual(fake.posted[0]?.text, 'Thinking...')
    assert.strictEqual(fake.posted[0]?.threadId, 'slack:C456:')

    yield* platform.updateWorking({ binding: channelBinding, text: 'Running commands...' })
    assert.strictEqual(fake.edited[0]?.text, 'Running commands...')

    const long = `status ${'word '.repeat(60)}`
    yield* platform.updateWorking({ binding: channelBinding, text: long })
    assert.strictEqual(fake.edited[1]?.text, long)
    assertNoNativeStatus(fake)
  }),
)

it.effect('edits the thread working message when it remains latest', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)

    yield* platform.beginWorking({ binding: threadBinding, text: 'Thinking...' })
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Thread answer.' })

    assert.strictEqual(fake.posted.length, 1)
    assert.strictEqual(fake.edited.length, 1)
    assert.strictEqual(fake.edited[0]?.text, 'Thread answer.')
    assert.strictEqual(fake.deleted.length, 0)
    // The latest check reads exactly one thread message.
    assert.deepStrictEqual(fake.fetchOptions, [{ limit: 1 }])
  }),
)

it.effect('reposts fresh when history is empty instead of throwing', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)

    yield* platform.beginWorking({ binding: channelBinding, text: 'Thinking...' })
    fake.clearHistories()
    yield* platform.finalizeWorking({ binding: channelBinding, text: 'Final answer.' })

    assert.strictEqual(fake.posted.length, 2)
    assert.strictEqual(fake.posted[1]?.text, 'Final answer.')
    assert.strictEqual(fake.edited.length, 0)

    yield* platform.beginWorking({ binding: threadBinding, text: 'Thinking...' })
    fake.clearHistories()
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Thread answer.' })

    assert.strictEqual(fake.posted[fake.posted.length - 1]?.text, 'Thread answer.')
    assert.strictEqual(
      fake.posted[fake.posted.length - 1]?.threadId,
      'slack:C456:1234567890.111111',
    )
  }),
)

it.effect('tags publication failures with the failing operation', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const failing = {
      ...fake.adapter,
      postMessage: () => Promise.reject(new Error('post down')),
    }
    const platform = yield* makeSlackPlatform(connectionId, failing)

    const publishExit = yield* platform
      .publish({ binding: channelBinding, text: 'hello' })
      .pipe(Effect.exit)
    assert.strictEqual(publishExit._tag, 'Failure')
    if (publishExit._tag === 'Failure') {
      const error = Cause.squash(publishExit.cause)
      assert.isTrue(isPublicationError(error))
      if (isPublicationError(error)) assert.strictEqual(error.operation, 'publish')
    }

    const beginExit = yield* platform
      .beginWorking({ binding: channelBinding, text: 'working…' })
      .pipe(Effect.exit)
    assert.strictEqual(beginExit._tag, 'Failure')
    if (beginExit._tag === 'Failure') {
      const error = Cause.squash(beginExit.cause)
      assert.isTrue(isPublicationError(error))
      if (isPublicationError(error)) assert.strictEqual(error.operation, 'begin-working')
    }
  }),
)

it.effect('tags update and finalize failures with the failing operation', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const failingEdit = {
      ...fake.adapter,
      editMessage: () => Promise.reject(new Error('edit down')),
    }
    const editPlatform = yield* makeSlackPlatform(connectionId, failingEdit)
    yield* editPlatform.beginWorking({ binding: channelBinding, text: 'working…' })
    const updateExit = yield* editPlatform
      .updateWorking({ binding: channelBinding, text: 'still working…' })
      .pipe(Effect.exit)
    assert.strictEqual(updateExit._tag, 'Failure')
    if (updateExit._tag === 'Failure') {
      const error = Cause.squash(updateExit.cause)
      assert.isTrue(isPublicationError(error))
      if (isPublicationError(error)) assert.strictEqual(error.operation, 'update-working')
    }
  }),
)

it.effect('tags acknowledgement failures with the failing operation', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const failing = {
      ...fake.adapter,
      addReaction: () => Promise.reject(new Error('reaction down')),
    }
    const platform = yield* makeSlackPlatform(connectionId, failing)

    const exit = yield* platform
      .acknowledge({
        binding: channelBinding,
        messageId: decodeMessageId('1234567890.111111'),
      })
      .pipe(Effect.exit)
    assert.strictEqual(exit._tag, 'Failure')
    if (exit._tag === 'Failure') {
      const error = Cause.squash(exit.cause)
      assert.isTrue(isPublicationError(error))
      if (isPublicationError(error)) assert.strictEqual(error.operation, 'acknowledge')
    }
  }),
)

it.effect('searches channel history through the adapter', () =>
  Effect.gen(function* () {
    const fake = makeFakeAdapter()
    const platform = yield* makeSlackPlatform(connectionId, fake.adapter)
    yield* platform.publish({ binding: channelBinding, text: 'deploy pipeline notes' })

    const result = yield* platform.searchMessages({
      binding: channelBinding,
      query: 'deploy',
      limit: 10,
      scope: 'channel',
    })
    assert.strictEqual(result.messages.length, 1)
    assert.ok(result.messages[0]?.text.includes('deploy') ?? false)
  }),
)
