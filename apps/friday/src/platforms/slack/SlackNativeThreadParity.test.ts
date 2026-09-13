import { assert, it } from '@effect/vitest'
import { ConversationBinding, InputMessage } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import type { ChatSdkInboundKind } from '../chat-sdk/ChatSdkLifecycle.ts'
import { admitPlatformMessage, type PlatformAdmissionHooks } from '../PlatformAdmission.ts'
import type { PlatformInput } from '../PlatformAdapter.ts'
import { shouldInvoke as shouldInvokeDiscord } from '../discord/DiscordChannelAccess.ts'
import {
  containsDirectMention,
  isSlackDirectMessageChannel,
  resolveSlackChannelPolicy,
  shouldInvokeSlack,
  type SlackConnectionPolicies,
  type SlackResolvedChannelPolicy,
} from './SlackChannelAccess.ts'
import { decodeSlackConversationId } from './SlackConversationScope.ts'
import { projectSlackChatMessage, projectSlackMessage } from './SlackMessageProjection.ts'
import { makeSlackThreadRoute } from './SlackThreadRouting.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeInputMessage = Schema.decodeSync(InputMessage)

const TEAM = 'T123'
const CHANNEL = 'C042Y5ZKJSE'
const THREAD_TS = '1234567890.111111'
const THREAD_CONVERSATION = `slack:${TEAM}:${CHANNEL}:${THREAD_TS}`
const CHANNEL_CONVERSATION = `slack:${TEAM}:${CHANNEL}`

const policies = (invocationMode: 'mention-only' | 'all-messages'): SlackConnectionPolicies => ({
  access: {
    users: { mode: 'all', ids: [] },
    channels: { mode: 'all', ids: [] },
    workspaces: { mode: 'all', ids: [] },
  },
  defaultReplyMode: 'reply-in-channel',
  channels: [{ channelId: CHANNEL, invocationMode, replyMode: 'reply-in-channel' }],
})

const threadInput = (
  overrides: {
    readonly text?: string
    readonly ts?: string
    readonly conversationId?: string
  } = {},
): PlatformInput => {
  const conversationId = overrides.conversationId ?? THREAD_CONVERSATION
  return {
    binding: decodeBinding({
      platform: 'slack',
      connectionId: 'slack-conn',
      channelId: CHANNEL_CONVERSATION,
      sourceMessageId: overrides.ts ?? '1234567890.222222',
      conversationId,
    }),
    message: decodeInputMessage({
      source: 'user',
      author: {
        platformUserId: 'U111',
        mention: '<@U111>',
        username: null,
        displayName: null,
      },
      content: { text: overrides.text ?? 'follow-up in my thread', images: [] },
      platformMessageId: overrides.ts ?? '1234567890.222222',
    }),
  }
}

const topLevelInput = (text = 'top-level chatter'): PlatformInput =>
  threadInput({ text, ts: '1234567890.111111', conversationId: CHANNEL_CONVERSATION })

const hooksFor = (
  connection: SlackConnectionPolicies,
  options: { readonly botUserId?: string; readonly seen?: Set<string> } = {},
): PlatformAdmissionHooks<SlackResolvedChannelPolicy> => ({
  platform: 'slack',
  connectionId: 'slack-conn',
  resolvePolicy: (input) => {
    const location = decodeSlackConversationId(String(input.binding.conversationId))
    if (location === undefined) return undefined
    const resolved = resolveSlackChannelPolicy(connection, location.teamId, location.channelId)
    return resolved._tag === 'Some' ? resolved.value : undefined
  },
  isUserAdmitted: (input, policy) =>
    input.message.author !== undefined &&
    isAllowedByPolicy(String(input.message.author.platformUserId), policy.users),
  checkDuplicate:
    options.seen === undefined
      ? undefined
      : (input) => {
          const location = decodeSlackConversationId(String(input.binding.conversationId))
          if (location === undefined) return false
          const key = `${location.teamId}:${location.channelId}:${String(
            input.message.platformMessageId ?? input.binding.sourceMessageId,
          )}`
          if (options.seen?.has(key) === true) return true
          options.seen?.add(key)
          return false
        },
  shouldInvoke: ({ input, policy, hasBinding, kind }) => {
    const location = decodeSlackConversationId(String(input.binding.conversationId))
    if (location === undefined) return false
    return shouldInvokeSlack({
      isDirectMessage: isSlackDirectMessageChannel(location.channelId),
      hasBinding,
      isDirectMention:
        kind === 'mention' ||
        containsDirectMention(input.message.content.text, options.botUserId ?? ''),
      invocationMode: policy.invocationMode,
    })
  },
})

const runAdmit = (
  input: PlatformInput,
  kind: ChatSdkInboundKind,
  hooks: PlatformAdmissionHooks<SlackResolvedChannelPolicy>,
  hasBinding: boolean,
) =>
  Effect.gen(function* () {
    let calls = 0
    const admitted = yield* admitPlatformMessage(input, kind, hooks, {
      hasBinding: () => Effect.succeed(hasBinding),
      onAdmit: () =>
        Effect.sync(() => {
          calls += 1
        }),
    })
    return { admitted, calls }
  })

it.effect('admits the first unmentioned native-thread message in all-messages', () =>
  Effect.gen(function* () {
    // Reported flow: reply-in-channel + all-messages, user starts a native
    // thread and writes inside it. Chat delivers it past the subscribed
    // handlers to the catch-all as `subscribed-message` with no mention and
    // no Friday binding yet; it must start a separate Friday thread.
    const hooks = hooksFor(policies('all-messages'), { botUserId: 'U999' })
    const result = yield* runAdmit(threadInput(), 'subscribed-message', hooks, false)
    assert.deepStrictEqual(result, { admitted: true, calls: 1 })
  }),
)

it.effect('continues the native thread without a new mention in all-messages', () =>
  Effect.gen(function* () {
    const hooks = hooksFor(policies('all-messages'), { botUserId: 'U999' })
    const result = yield* runAdmit(
      threadInput({ text: 'second message', ts: '1234567890.333333' }),
      'subscribed-message',
      hooks,
      true,
    )
    assert.deepStrictEqual(result, { admitted: true, calls: 1 })
  }),
)

it.effect('requires a mention or binding for native threads in mention-only', () =>
  Effect.gen(function* () {
    const hooks = hooksFor(policies('mention-only'), { botUserId: 'U999' })
    const dropped = yield* runAdmit(threadInput(), 'subscribed-message', hooks, false)
    assert.deepStrictEqual(dropped, { admitted: false, calls: 0 })

    const mentioned = yield* runAdmit(
      threadInput({ text: 'hey <@U999> help in my thread' }),
      'subscribed-message',
      hooks,
      false,
    )
    assert.deepStrictEqual(mentioned, { admitted: true, calls: 1 })

    const mentionKind = yield* runAdmit(threadInput({ text: 'hello' }), 'mention', hooks, false)
    assert.deepStrictEqual(mentionKind, { admitted: true, calls: 1 })

    const continuation = yield* runAdmit(threadInput(), 'subscribed-message', hooks, true)
    assert.deepStrictEqual(continuation, { admitted: true, calls: 1 })
  }),
)

it.effect('keeps top-level channel behavior unchanged', () =>
  Effect.gen(function* () {
    const allMessages = hooksFor(policies('all-messages'), { botUserId: 'U999' })
    const admitted = yield* runAdmit(topLevelInput(), 'subscribed-message', allMessages, false)
    assert.deepStrictEqual(admitted, { admitted: true, calls: 1 })

    const mentionOnly = hooksFor(policies('mention-only'), { botUserId: 'U999' })
    const dropped = yield* runAdmit(topLevelInput(), 'subscribed-message', mentionOnly, false)
    assert.deepStrictEqual(dropped, { admitted: false, calls: 0 })
  }),
)

it.effect('collapses socket redeliveries of the same native-thread message', () =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    const hooks = hooksFor(policies('all-messages'), { botUserId: 'U999', seen })
    const first = yield* runAdmit(threadInput(), 'subscribed-message', hooks, false)
    assert.deepStrictEqual(first, { admitted: true, calls: 1 })
    // Same platform message id redelivered (e.g. catch-all plus a retry)
    // drops as a duplicate without a second turn.
    const redelivery = yield* runAdmit(threadInput(), 'subscribed-message', hooks, true)
    assert.deepStrictEqual(redelivery, { admitted: false, calls: 0 })
  }),
)

it.effect('projects native-thread replies to the thread conversation', () =>
  Effect.gen(function* () {
    const input = yield* projectSlackChatMessage(
      'slack-conn',
      {
        id: `slack:${CHANNEL}:${THREAD_TS}`,
        channelId: `slack:${CHANNEL}`,
        adapter: { name: 'slack' },
      },
      {
        id: '1234567890.222222',
        text: 'converted-text',
        raw: {
          channel: CHANNEL,
          team_id: TEAM,
          text: 'follow-up in my thread',
          thread_ts: THREAD_TS,
          ts: '1234567890.222222',
        },
        author: { userId: 'U111', userName: 'chan', fullName: 'Chan', isBot: false, isMe: false },
      },
    )
    assert.strictEqual(String(input.binding.conversationId), THREAD_CONVERSATION)
    assert.strictEqual(input.historySource, 'thread')

    const topLevel = projectSlackMessage('slack-conn', {
      teamId: TEAM,
      channelId: CHANNEL,
      ts: THREAD_TS,
      userId: 'U111',
      text: 'channel root',
    })
    assert.strictEqual(String(topLevel.binding.conversationId), CHANNEL_CONVERSATION)
    assert.strictEqual(topLevel.historySource, 'channel')
  }),
)

it.effect('preserves native threads through reply-in-channel routing', () =>
  Effect.gen(function* () {
    const route = makeSlackThreadRoute({
      decide: () =>
        Effect.succeed({ decision: 'create-thread', reason: 'thread-beneficial' } as const),
      resolveChannelPolicy: () => ({
        invocationMode: 'all-messages' as const,
        replyMode: 'reply-in-channel' as const,
        users: { mode: 'all' as const, ids: [] },
      }),
    })
    const kept = yield* route(threadInput())
    assert.strictEqual(String(kept.binding.conversationId), THREAD_CONVERSATION)
  }),
)

it('matches Discord manual-thread parity from source', () => {
  // Discord admits every subscribed message in all-messages mode regardless
  // of thread position or binding; Slack now does the same for native
  // threads while keeping its bound-continuation signal for mention-only.
  assert.strictEqual(
    shouldInvokeDiscord({ kind: 'subscribed-message', mode: 'all-messages', hasBinding: false }),
    true,
  )
  assert.strictEqual(
    shouldInvokeSlack({
      isDirectMessage: false,
      hasBinding: false,
      isDirectMention: false,
      invocationMode: 'all-messages',
    }),
    true,
  )
})
