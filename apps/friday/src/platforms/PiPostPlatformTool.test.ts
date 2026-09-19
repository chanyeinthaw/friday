import { assert, it } from '@effect/vitest'
import { ChannelThread, PlatformMessageId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { DiscordMaxPostLength } from './discord/DiscordMessageSearch.ts'
import { SlackMaxPostLength } from './slack/SlackMessageSearch.ts'
import { makePiPostPlatformTool } from './PiPostPlatformTool.ts'
import type { PlatformMessagePostQuery } from './PlatformAdapter.ts'
import type { PlatformRegistryContract } from './PlatformRegistry.ts'
import { PlatformPostIdempotency } from './PlatformPostIdempotency.ts'

type Platforms = Pick<PlatformRegistryContract, 'postMessage'>

const decodeMessageId = Schema.decodeSync(PlatformMessageId)

const thread = Schema.decodeSync(ChannelThread)({
  id: 'thread-post-tool',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/post-tool',
  model: { provider: 'openai', modelId: 'gpt' },
  thinkingLevel: 'medium',
  channelContext: { name: 'post', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord-main',
    channelId: 'discord:guild:channel',
    sourceMessageId: 'message-1',
    conversationId: 'discord:guild:channel:thread',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

const postStub = (
  requests: Array<PlatformMessagePostQuery>,
  messageId: string | null = 'posted-1',
): Platforms => ({
  postMessage: (request) =>
    Effect.sync(() => {
      requests.push(request)
      return { messageId: messageId === null ? null : decodeMessageId(messageId) }
    }),
})

const neverPost = (): Platforms => ({
  postMessage: () => Effect.die('should not run'),
})

// SAFETY: The post tool does not read ExtensionContext for these operations.
const extensionContext = {} as never

const decodePostThread = Schema.decodeSync(ChannelThread)
const encodePostThread = Schema.encodeSync(ChannelThread)

const discordTarget = { platform: 'discord', guildId: 'guild-1', channelId: 'channel-1' } as const

it('is named post_platform and runs sequentially', () => {
  const tool = makePiPostPlatformTool({
    thread,
    platforms: neverPost(),
    runPromise: Effect.runPromise,
  })

  assert.strictEqual(tool.name, 'post_platform')
  assert.strictEqual(tool.executionMode, 'sequential')
})

it('posts one message and returns the native id', async () => {
  const requests: Array<PlatformMessagePostQuery> = []
  const tool = makePiPostPlatformTool({
    thread,
    platforms: postStub(requests),
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })

  const result = await tool.execute(
    'call-1',
    { target: discordTarget, text: 'hello channel', idempotencyKey: 'key-1' },
    undefined,
    undefined,
    extensionContext,
  )

  assert.strictEqual(requests.length, 1)
  assert.deepStrictEqual(requests[0], {
    binding: thread.conversationBinding,
    target: discordTarget,
    text: 'hello channel',
  })
  assert.deepStrictEqual(result.details, { messageId: decodeMessageId('posted-1') })
})

it('returns a posted result without fabricating an id', async () => {
  const requests: Array<PlatformMessagePostQuery> = []
  const tool = makePiPostPlatformTool({
    thread,
    platforms: postStub(requests, null),
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })

  const result = await tool.execute(
    'call-1',
    { target: discordTarget, text: 'hello', idempotencyKey: 'key-1' },
    undefined,
    undefined,
    extensionContext,
  )

  assert.deepStrictEqual(result.details, { messageId: null })
})

it('posts to a matching-workspace Slack target on the current connection', async () => {
  const slackThread = decodePostThread({
    ...encodePostThread(thread),
    conversationBinding: {
      platform: 'slack',
      connectionId: 'slack-main',
      channelId: 'slack:T123:C456',
      sourceMessageId: '1234567890.111111',
      conversationId: 'slack:T123:C456',
    },
  })
  const requests: Array<PlatformMessagePostQuery> = []
  const tool = makePiPostPlatformTool({
    thread: slackThread,
    platforms: postStub(requests),
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })

  const result = await tool.execute(
    'call-1',
    {
      target: { platform: 'slack', workspaceId: 'T123', channelId: 'C456' },
      text: 'hello slack',
      idempotencyKey: 'slack-1',
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
  assert.deepStrictEqual(result.details, { messageId: decodeMessageId('posted-1') })
})

it('rejects cross-connection targets', async () => {
  const tool = makePiPostPlatformTool({
    thread,
    platforms: neverPost(),
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    await tool.execute(
      'call-1',
      {
        target: { platform: 'slack', workspaceId: 'T123', channelId: 'C456' },
        text: 'hello',
        idempotencyKey: 'key-1',
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

it('rejects empty text, missing keys, and over-limit text', async () => {
  const tool = makePiPostPlatformTool({
    thread,
    platforms: neverPost(),
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })

  const emptyError = await tool
    .execute(
      'call-1',
      { target: discordTarget, text: '   ', idempotencyKey: 'key-1' },
      undefined,
      undefined,
      extensionContext,
    )
    .then(
      () => undefined,
      (cause) => cause,
    )
  assert.match(String(emptyError), /must not be empty/)
  const keyError = await tool
    .execute(
      'call-1',
      { target: discordTarget, text: 'hello', idempotencyKey: '   ' },
      undefined,
      undefined,
      extensionContext,
    )
    .then(
      () => undefined,
      (cause) => cause,
    )
  assert.match(String(keyError), /idempotency key/i)
  const limitError = await tool
    .execute(
      'call-1',
      {
        target: discordTarget,
        text: 'x'.repeat(DiscordMaxPostLength + 1),
        idempotencyKey: 'k',
      },
      undefined,
      undefined,
      extensionContext,
    )
    .then(
      () => undefined,
      (cause) => cause,
    )
  assert.match(String(limitError), new RegExp(String(DiscordMaxPostLength)))
})

it('enforces the Slack single-message limit', async () => {
  const slackThread = decodePostThread({
    ...encodePostThread(thread),
    conversationBinding: {
      platform: 'slack',
      connectionId: 'slack-main',
      channelId: 'slack:T123:C456',
      sourceMessageId: '1234567890.111111',
      conversationId: 'slack:T123:C456',
    },
  })
  const tool = makePiPostPlatformTool({
    thread: slackThread,
    platforms: neverPost(),
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })

  let error: unknown
  try {
    await tool.execute(
      'call-1',
      {
        target: { platform: 'slack', workspaceId: 'T123', channelId: 'C456' },
        text: 'x'.repeat(SlackMaxPostLength + 1),
        idempotencyKey: 'key-1',
      },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), new RegExp(String(SlackMaxPostLength)))
})

it('replays the prior result for the same key and payload without re-posting', async () => {
  const requests: Array<PlatformMessagePostQuery> = []
  const tool = makePiPostPlatformTool({
    thread,
    platforms: postStub(requests),
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })
  const input = { target: discordTarget, text: 'hello once', idempotencyKey: 'retry-1' }

  const first = await tool.execute('call-1', input, undefined, undefined, extensionContext)
  const second = await tool.execute('call-2', input, undefined, undefined, extensionContext)

  assert.strictEqual(requests.length, 1)
  assert.deepStrictEqual(second.details, first.details)
})

it('rejects the same key with a different payload', async () => {
  const requests: Array<PlatformMessagePostQuery> = []
  const tool = makePiPostPlatformTool({
    thread,
    platforms: postStub(requests),
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })

  await tool.execute(
    'call-1',
    { target: discordTarget, text: 'first', idempotencyKey: 'spent-1' },
    undefined,
    undefined,
    extensionContext,
  )
  let error: unknown
  try {
    await tool.execute(
      'call-2',
      { target: discordTarget, text: 'second', idempotencyKey: 'spent-1' },
      undefined,
      undefined,
      extensionContext,
    )
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /different post payload/)
  assert.strictEqual(requests.length, 1)
})

it('deduplicates concurrent posts sharing one key', async () => {
  const requests: Array<PlatformMessagePostQuery> = []
  let posts = 0
  const platforms: Platforms = {
    postMessage: (request) =>
      Effect.promise(async () => {
        posts += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        requests.push(request)
        return { messageId: decodeMessageId('posted-1') }
      }),
  }
  const tool = makePiPostPlatformTool({
    thread,
    platforms,
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })
  const input = { target: discordTarget, text: 'hello race', idempotencyKey: 'race-1' }

  const [first, second] = await Promise.all([
    tool.execute('call-1', input, undefined, undefined, extensionContext),
    tool.execute('call-2', input, undefined, undefined, extensionContext),
  ])

  assert.strictEqual(posts, 1)
  assert.deepStrictEqual(second.details, first.details)
})

it('retries the same key and payload after a failed post without reusing a receipt', async () => {
  let attempts = 0
  const platforms: Platforms = {
    postMessage: () =>
      Effect.promise(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transport down')
        return { messageId: decodeMessageId('posted-1') }
      }),
  }
  const tool = makePiPostPlatformTool({
    thread,
    platforms,
    idempotency: new PlatformPostIdempotency(),
    runPromise: Effect.runPromise,
  })
  const input = { target: discordTarget, text: 'hello retry', idempotencyKey: 'retry-after-fail' }

  let error: unknown
  try {
    await tool.execute('call-1', input, undefined, undefined, extensionContext)
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /transport down/)
  const recovered = await tool.execute('call-2', input, undefined, undefined, extensionContext)
  assert.deepStrictEqual(recovered.details, { messageId: decodeMessageId('posted-1') })
  assert.strictEqual(attempts, 2)
})

it('scopes idempotency keys to the current connection', async () => {
  const requests: Array<PlatformMessagePostQuery> = []
  const idempotency = new PlatformPostIdempotency()
  const otherThread = decodePostThread({
    ...encodePostThread(thread),
    conversationBinding: {
      platform: 'discord',
      connectionId: 'discord-other',
      channelId: 'discord:guild:channel',
      sourceMessageId: 'message-1',
      conversationId: 'discord:guild:channel:thread',
    },
  })
  const input = { target: discordTarget, text: 'hello', idempotencyKey: 'shared-1' }

  await makePiPostPlatformTool({
    thread,
    platforms: postStub(requests),
    idempotency,
    runPromise: Effect.runPromise,
  }).execute('call-1', input, undefined, undefined, extensionContext)
  await makePiPostPlatformTool({
    thread: otherThread,
    platforms: postStub(requests),
    idempotency,
    runPromise: Effect.runPromise,
  }).execute('call-2', input, undefined, undefined, extensionContext)

  assert.strictEqual(requests.length, 2)
})
