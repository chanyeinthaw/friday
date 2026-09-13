import { assert, it } from '@effect/vitest'
import { PlatformConversationId, PlatformMessageId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { ThreadRouteDecision } from '../PlatformThreadRouter.ts'
import { PlatformThreadRouterError } from '../PlatformThreadRouter.ts'
import { makeSlackThreadRoute, rebindToSlackThread } from './SlackThreadRouting.ts'
import { projectSlackMessage } from './SlackMessageProjection.ts'

const inputFor = (text: string) =>
  projectSlackMessage('slack-personal', {
    teamId: 'T123',
    channelId: 'C456',
    ts: '1234567890.111111',
    userId: 'U789',
    text,
  })

const decideKeep = () =>
  Effect.succeed({
    decision: 'keep-channel',
    reason: 'channel-appropriate',
  } satisfies ThreadRouteDecision)

const decideCreate = () =>
  Effect.succeed({
    decision: 'create-thread',
    reason: 'thread-beneficial',
  } satisfies ThreadRouteDecision)

const decodeConversationId = Schema.decodeSync(PlatformConversationId)
const decodeMessageId = Schema.decodeSync(PlatformMessageId)

it('rebinds routed messages to the source-rooted thread', () => {
  const rebound = rebindToSlackThread(inputFor('build this'), '1234567890.111111')
  assert.strictEqual(String(rebound.binding.channelId), 'slack:T123:C456')
  assert.strictEqual(String(rebound.binding.conversationId), 'slack:T123:C456:1234567890.111111')
  assert.strictEqual(rebound.historySource, 'thread')
  assert.strictEqual(rebound.discordHistorySource, 'thread')
  assert.strictEqual(rebound.message.content.text, 'build this')
})

it('passes foreign bindings through rebinding untouched', () => {
  const foreign = {
    ...inputFor('build this'),
    binding: {
      ...inputFor('build this').binding,
      conversationId: decodeConversationId('discord:guild-1:channel-1'),
    },
  }
  const rebound = rebindToSlackThread(foreign, '1234567890.111111')
  assert.strictEqual(String(rebound.binding.conversationId), 'discord:guild-1:channel-1')
  assert.strictEqual(rebound.historySource, 'thread')
})

it.effect('keeps top-level reply-in-channel messages in-channel on keep-channel', () =>
  Effect.gen(function* () {
    const route = makeSlackThreadRoute({
      decide: decideKeep,
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-channel',
        users: { mode: 'all', ids: [] },
      }),
    })
    const routed = yield* route(inputFor('thanks!'))
    assert.strictEqual(String(routed.binding.conversationId), 'slack:T123:C456')
    assert.strictEqual(routed.historySource, 'channel')
  }),
)

it.effect('routes top-level reply-in-channel messages to a thread on create-thread', () =>
  Effect.gen(function* () {
    const route = makeSlackThreadRoute({
      decide: decideCreate,
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-channel',
        users: { mode: 'all', ids: [] },
      }),
    })
    const routed = yield* route(inputFor('build the deploy pipeline'))
    assert.strictEqual(String(routed.binding.conversationId), 'slack:T123:C456:1234567890.111111')
    assert.strictEqual(routed.historySource, 'thread')
  }),
)

it.effect('binds fresh top-level reply-in-thread invocations to the crux thread', () =>
  Effect.gen(function* () {
    let decides = 0
    const routeThreadMode = makeSlackThreadRoute({
      decide: () => {
        decides += 1
        return decideCreate()
      },
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-thread',
        users: { mode: 'all', ids: [] },
      }),
    })
    const routed = yield* routeThreadMode(inputFor('simple question'))
    // A newly admitted top-level invocation binds the Friday conversation to
    // the crux Slack thread rooted at the source message timestamp, so
    // replies publish with that `thread_ts` instead of the channel root.
    assert.strictEqual(String(routed.binding.conversationId), 'slack:T123:C456:1234567890.111111')
    assert.strictEqual(routed.historySource, 'thread')
    assert.strictEqual(decides, 0)
  }),
)

it.effect('preserves DMs and existing threads in reply-in-thread mode', () =>
  Effect.gen(function* () {
    const routeThreadMode = makeSlackThreadRoute({
      decide: () => Effect.die(new Error('decide should not run for DMs or threads')),
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-thread',
        users: { mode: 'all', ids: [] },
      }),
    })
    const dm = projectSlackMessage('slack-personal', {
      teamId: 'T123',
      channelId: 'D789',
      ts: '1234567890.333333',
      userId: 'U789',
      text: 'dm hello',
    })
    const keptDm = yield* routeThreadMode(dm)
    assert.strictEqual(String(keptDm.binding.conversationId), 'slack:T123:D789')
    assert.strictEqual(keptDm.historySource, 'channel')

    const threaded = projectSlackMessage('slack-personal', {
      teamId: 'T123',
      channelId: 'C456',
      ts: '1234567890.222222',
      threadTs: '1234567890.111111',
      userId: 'U789',
      text: 'follow up',
    })
    const keptThread = yield* routeThreadMode(threaded)
    assert.strictEqual(
      String(keptThread.binding.conversationId),
      'slack:T123:C456:1234567890.111111',
    )
  }),
)

it.effect('keeps existing threads untouched in reply-in-channel mode', () =>
  Effect.gen(function* () {
    const routeChannelMode = makeSlackThreadRoute({
      decide: decideCreate,
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-channel',
        users: { mode: 'all', ids: [] },
      }),
    })
    const threaded = projectSlackMessage('slack-personal', {
      teamId: 'T123',
      channelId: 'C456',
      ts: '1234567890.222222',
      threadTs: '1234567890.111111',
      userId: 'U789',
      text: 'follow up',
    })
    const keptThread = yield* routeChannelMode(threaded)
    assert.strictEqual(
      String(keptThread.binding.conversationId),
      'slack:T123:C456:1234567890.111111',
    )
  }),
)

it.effect('leaves non-Slack and undecodable inputs alone', () =>
  Effect.gen(function* () {
    const route = makeSlackThreadRoute({
      decide: () => Effect.die(new Error('decide should not run')),
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-channel',
        users: { mode: 'all', ids: [] },
      }),
    })
    const discord = {
      ...inputFor('build this'),
      binding: { ...inputFor('build this').binding, platform: 'discord' as const },
    }
    assert.strictEqual(yield* route(discord), discord)
    const foreign = {
      ...inputFor('build this'),
      binding: {
        ...inputFor('build this').binding,
        conversationId: decodeConversationId('discord:guild-1:channel-1'),
      },
    }
    assert.strictEqual(yield* route(foreign), foreign)
  }),
)

it.effect('continues in the parent channel when the policy is unknown', () =>
  Effect.gen(function* () {
    const route = makeSlackThreadRoute({
      decide: () => Effect.die(new Error('decide should not run')),
      resolveChannelPolicy: () => undefined,
    })
    const routed = yield* route(inputFor('build this'))
    assert.strictEqual(String(routed.binding.conversationId), 'slack:T123:C456')
  }),
)

it.effect('rebinds to the platform message id rather than the source id', () =>
  Effect.gen(function* () {
    const seen: Array<{ readonly text: string }> = []
    const route = makeSlackThreadRoute({
      decide: (decideInput) => {
        seen.push({ text: `${decideInput.text}|${decideInput.context.length}` })
        return decideCreate()
      },
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-channel',
        users: { mode: 'all', ids: [] },
      }),
    })
    const input = {
      ...inputFor('build the deploy pipeline'),
      binding: {
        ...inputFor('build the deploy pipeline').binding,
        sourceMessageId: decodeMessageId('different-source-id'),
      },
    }
    const routed = yield* route(input)
    // The platform message id wins over the binding source id, and the decide
    // input carries the text plus channel context for the routing decision.
    assert.strictEqual(String(routed.binding.conversationId), 'slack:T123:C456:1234567890.111111')
    assert.deepStrictEqual(seen, [{ text: 'build the deploy pipeline|0' }])
  }),
)

it.effect('continues in the parent channel when the decision fails', () =>
  Effect.gen(function* () {
    const route = makeSlackThreadRoute({
      decide: () =>
        Effect.fail(new PlatformThreadRouterError({ operation: 'thread-route', detail: 'boom' })),
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-channel',
        users: { mode: 'all', ids: [] },
      }),
    })
    const routed = yield* route(inputFor('build this'))
    assert.strictEqual(String(routed.binding.conversationId), 'slack:T123:C456')
  }),
)
