import { assert, it } from '@effect/vitest'
import { ConversationBinding, InputMessage } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { isAllowedByPolicy } from './chat-sdk/AccessPolicy.ts'
import type { ChatSdkInboundKind } from './chat-sdk/ChatSdkLifecycle.ts'
import { admitPlatformMessage, type PlatformAdmissionHooks } from './PlatformAdmission.ts'
import type { PlatformInput } from './PlatformAdapter.ts'
import { shouldInvoke } from './discord/DiscordChannelAccess.ts'
import {
  containsDirectMention,
  isSlackDirectMessageChannel,
  resolveSlackChannelPolicy,
  shouldInvokeSlack,
  type SlackConnectionPolicies,
  type SlackResolvedChannelPolicy,
} from './slack/SlackChannelAccess.ts'
import { decodeSlackConversationId } from './slack/SlackConversationScope.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeInputMessage = Schema.decodeSync(InputMessage)

interface DiscordTestPolicy {
  readonly invocationMode: 'mention-only' | 'all-messages'
  readonly users: { readonly mode: 'all' | 'allow' | 'deny'; readonly ids: ReadonlyArray<string> }
}

const makeDiscordInput = (
  overrides: {
    readonly userId?: string
    readonly text?: string
  } = {},
): PlatformInput => ({
  binding: decodeBinding({
    platform: 'discord',
    connectionId: 'discord-conn',
    channelId: 'discord:channel-1',
    sourceMessageId: 'message-1',
    conversationId: 'discord:guild-1:channel-1:channel-1',
  }),
  message: decodeInputMessage({
    source: 'user',
    author: {
      platformUserId: overrides.userId ?? 'user-1',
      mention: `<@${overrides.userId ?? 'user-1'}>`,
      username: null,
      displayName: null,
    },
    content: { text: overrides.text ?? 'hello', images: [] },
    platformMessageId: 'message-1',
  }),
})

const discordHooks = (
  policy: DiscordTestPolicy | undefined,
  options: { readonly duplicate?: boolean } = {},
): PlatformAdmissionHooks<DiscordTestPolicy> => ({
  platform: 'discord',
  connectionId: 'discord-conn',
  resolvePolicy: () => policy,
  isUserAdmitted: (input, resolved) =>
    input.message.author !== undefined &&
    isAllowedByPolicy(String(input.message.author.platformUserId), resolved.users),
  checkDuplicate: options.duplicate ? () => true : undefined,
  shouldInvoke: ({ policy: resolved, hasBinding, kind }) =>
    shouldInvoke({ kind, mode: resolved.invocationMode, hasBinding }),
})

const slackPolicies = (
  overrides: Partial<SlackConnectionPolicies> = {},
): SlackConnectionPolicies => ({
  access: {
    users: { mode: 'all', ids: [] },
    channels: { mode: 'all', ids: [] },
    workspaces: { mode: 'all', ids: [] },
  },
  defaultReplyMode: 'reply-in-thread',
  channels: [],
  ...overrides,
})

const makeSlackInput = (
  overrides: {
    readonly conversationId?: string
    readonly channelId?: string
    readonly userId?: string
    readonly text?: string
    readonly platformMessageId?: string
  } = {},
): PlatformInput => {
  const conversationId = overrides.conversationId ?? 'slack:T123:C456'
  const channelId = overrides.channelId ?? 'slack:T123:C456'
  return {
    binding: decodeBinding({
      platform: 'slack',
      connectionId: 'slack-conn',
      channelId,
      sourceMessageId: overrides.platformMessageId ?? '1234567890.111111',
      conversationId,
    }),
    message: decodeInputMessage({
      source: 'user',
      author: {
        platformUserId: overrides.userId ?? 'U111',
        mention: `<@${overrides.userId ?? 'U111'}>`,
        username: null,
        displayName: null,
      },
      content: { text: overrides.text ?? 'hello', images: [] },
      platformMessageId: overrides.platformMessageId ?? '1234567890.111111',
    }),
  }
}

const slackHooks = (
  connection: SlackConnectionPolicies,
  options: { readonly botUserId?: string; readonly duplicateKeys?: Set<string> } = {},
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
    options.duplicateKeys === undefined
      ? undefined
      : (input) => {
          const location = decodeSlackConversationId(String(input.binding.conversationId))
          if (location === undefined) return false
          const key = `${location.teamId}:${location.channelId}:${String(
            input.message.platformMessageId ?? input.binding.sourceMessageId,
          )}`
          if (options.duplicateKeys?.has(key) === true) return true
          options.duplicateKeys?.add(key)
          return false
        },
  shouldInvoke: ({ input, policy, hasBinding, kind }) => {
    const location = decodeSlackConversationId(String(input.binding.conversationId))
    if (location === undefined) return false
    const isDirectMessage = isSlackDirectMessageChannel(location.channelId)
    const isDirectMention =
      kind === 'mention' ||
      containsDirectMention(input.message.content.text, options.botUserId ?? '')
    return shouldInvokeSlack({
      isDirectMessage,
      hasBinding,
      isDirectMention,
      invocationMode: policy.invocationMode,
    })
  },
})

const runAdmit = <Policy>(
  input: PlatformInput,
  kind: ChatSdkInboundKind,
  hooks: PlatformAdmissionHooks<Policy>,
  options: { readonly hasBinding?: boolean | Error; readonly onAdmitFail?: Error } = {},
) =>
  Effect.gen(function* () {
    let admitted = 0
    const admittedFlag = yield* admitPlatformMessage(input, kind, hooks, {
      hasBinding: () =>
        options.hasBinding instanceof Error
          ? Effect.fail(options.hasBinding)
          : Effect.succeed(options.hasBinding ?? false),
      onAdmit: () =>
        options.onAdmitFail instanceof Error
          ? Effect.fail(options.onAdmitFail)
          : Effect.sync(() => {
              admitted += 1
            }),
    })
    return { admitted: admittedFlag, calls: admitted }
  })

it.effect('admits all-mode users and denies unauthorized users', () =>
  Effect.gen(function* () {
    const allowed = yield* runAdmit(
      makeDiscordInput({ userId: 'anyone' }),
      'mention',
      discordHooks({ invocationMode: 'mention-only', users: { mode: 'all', ids: [] } }),
    )
    assert.deepStrictEqual(allowed, { admitted: true, calls: 1 })

    const denied = yield* runAdmit(
      makeDiscordInput({ userId: 'blocked' }),
      'mention',
      discordHooks({ invocationMode: 'mention-only', users: { mode: 'deny', ids: ['blocked'] } }),
    )
    assert.deepStrictEqual(denied, { admitted: false, calls: 0 })
  }),
)

it.effect('honors allow-lists without treating empty deny as invalid', () =>
  Effect.gen(function* () {
    // `deny: []` denies nobody; it must not be treated as an invalid policy.
    const emptyDeny = yield* runAdmit(
      makeDiscordInput({ userId: 'anyone' }),
      'mention',
      discordHooks({ invocationMode: 'mention-only', users: { mode: 'deny', ids: [] } }),
    )
    assert.deepStrictEqual(emptyDeny, { admitted: true, calls: 1 })

    const allowed = yield* runAdmit(
      makeDiscordInput({ userId: 'known' }),
      'mention',
      discordHooks({ invocationMode: 'mention-only', users: { mode: 'allow', ids: ['known'] } }),
    )
    assert.deepStrictEqual(allowed, { admitted: true, calls: 1 })

    const unlisted = yield* runAdmit(
      makeDiscordInput({ userId: 'other' }),
      'mention',
      discordHooks({ invocationMode: 'mention-only', users: { mode: 'allow', ids: ['known'] } }),
    )
    assert.deepStrictEqual(unlisted, { admitted: false, calls: 0 })
  }),
)

it.effect('drops unauthorized scope without ingesting', () =>
  Effect.gen(function* () {
    const dropped = yield* runAdmit(makeDiscordInput(), 'mention', discordHooks(undefined))
    assert.deepStrictEqual(dropped, { admitted: false, calls: 0 })
  }),
)

it.effect('invokes Discord mentions and DMs while gating subscribed chatter by mode', () =>
  Effect.gen(function* () {
    const policy: DiscordTestPolicy = {
      invocationMode: 'mention-only',
      users: { mode: 'all', ids: [] },
    }
    const mention = yield* runAdmit(makeDiscordInput(), 'mention', discordHooks(policy))
    assert.deepStrictEqual(mention, { admitted: true, calls: 1 })

    const dm = yield* runAdmit(makeDiscordInput(), 'direct-message', discordHooks(policy))
    assert.deepStrictEqual(dm, { admitted: true, calls: 1 })

    const chatter = yield* runAdmit(
      makeDiscordInput(),
      'subscribed-message',
      discordHooks(policy),
      { hasBinding: false },
    )
    assert.deepStrictEqual(chatter, { admitted: false, calls: 0 })

    // A persisted binding does not turn mention-only into all-messages.
    const boundChatter = yield* runAdmit(
      makeDiscordInput(),
      'subscribed-message',
      discordHooks(policy),
      { hasBinding: true },
    )
    assert.deepStrictEqual(boundChatter, { admitted: false, calls: 0 })

    const allMessages = yield* runAdmit(
      makeDiscordInput(),
      'subscribed-message',
      discordHooks({ ...policy, invocationMode: 'all-messages' }),
      { hasBinding: false },
    )
    assert.deepStrictEqual(allMessages, { admitted: true, calls: 1 })
  }),
)

it.effect('drops duplicate messages without ingesting', () =>
  Effect.gen(function* () {
    const policy: DiscordTestPolicy = {
      invocationMode: 'mention-only',
      users: { mode: 'all', ids: [] },
    }
    const dropped = yield* runAdmit(
      makeDiscordInput(),
      'mention',
      discordHooks(policy, { duplicate: true }),
    )
    assert.deepStrictEqual(dropped, { admitted: false, calls: 0 })
  }),
)

it.effect('invokes Slack DMs and bound continuations without a new mention', () =>
  Effect.gen(function* () {
    const hooks = slackHooks(slackPolicies(), { botUserId: 'U999' })
    const dm = yield* runAdmit(
      makeSlackInput({ conversationId: 'slack:T123:D789', channelId: 'slack:T123:D789' }),
      'direct-message',
      hooks,
      { hasBinding: false },
    )
    assert.deepStrictEqual(dm, { admitted: true, calls: 1 })

    const continuation = yield* runAdmit(
      makeSlackInput({ text: 'follow-up without mention' }),
      'subscribed-message',
      hooks,
      { hasBinding: true },
    )
    assert.deepStrictEqual(continuation, { admitted: true, calls: 1 })
  }),
)

it.effect('requires a direct mention for unbound Slack channel chatter', () =>
  Effect.gen(function* () {
    const hooks = slackHooks(slackPolicies(), { botUserId: 'U999' })
    const mentioned = yield* runAdmit(
      makeSlackInput({ text: 'hey <@U999> help' }),
      'subscribed-message',
      hooks,
      { hasBinding: false },
    )
    assert.deepStrictEqual(mentioned, { admitted: true, calls: 1 })

    const mentionKind = yield* runAdmit(makeSlackInput({ text: 'hello' }), 'mention', hooks, {
      hasBinding: false,
    })
    assert.deepStrictEqual(mentionKind, { admitted: true, calls: 1 })

    const chatter = yield* runAdmit(
      makeSlackInput({ text: 'just chatting' }),
      'subscribed-message',
      hooks,
      { hasBinding: false },
    )
    assert.deepStrictEqual(chatter, { admitted: false, calls: 0 })
  }),
)

it.effect(
  'admits channel and native-thread chatter without a mention in all-messages channels',
  () =>
    Effect.gen(function* () {
      const hooks = slackHooks(
        slackPolicies({ channels: [{ channelId: 'C456', invocationMode: 'all-messages' }] }),
        { botUserId: 'U999' },
      )
      const admitted = yield* runAdmit(
        makeSlackInput({ text: 'just chatting' }),
        'subscribed-message',
        hooks,
        { hasBinding: false },
      )
      assert.deepStrictEqual(admitted, { admitted: true, calls: 1 })

      // Broadcast mentions invoke because of the channel mode, not parsing.
      const broadcast = yield* runAdmit(
        makeSlackInput({ text: 'hey <!channel> look' }),
        'subscribed-message',
        hooks,
        { hasBinding: false },
      )
      assert.deepStrictEqual(broadcast, { admitted: true, calls: 1 })

      // User-created native-thread replies invoke without a mention or a
      // bound thread, matching Discord manual-thread parity; the first message
      // starts a separate Friday thread bound to the native thread.
      const threadReply = yield* runAdmit(
        makeSlackInput({
          conversationId: 'slack:T123:C456:1234567890.111111',
          text: 'unmentioned follow-up',
        }),
        'subscribed-message',
        hooks,
        { hasBinding: false },
      )
      assert.deepStrictEqual(threadReply, { admitted: true, calls: 1 })

      const boundReply = yield* runAdmit(
        makeSlackInput({
          conversationId: 'slack:T123:C456:1234567890.111111',
          text: 'unmentioned follow-up',
        }),
        'subscribed-message',
        hooks,
        { hasBinding: true },
      )
      assert.deepStrictEqual(boundReply, { admitted: true, calls: 1 })
    }),
)

it.effect('keeps unauthorized all-messages chatter dropped', () =>
  Effect.gen(function* () {
    const scoped = slackHooks(
      slackPolicies({
        access: {
          users: { mode: 'deny', ids: ['U111'] },
          channels: { mode: 'all', ids: [] },
          workspaces: { mode: 'all', ids: [] },
        },
        channels: [{ channelId: 'C456', invocationMode: 'all-messages' }],
      }),
      { botUserId: 'U999' },
    )
    const unauthorized = yield* runAdmit(
      makeSlackInput({ text: 'just chatting', userId: 'U111' }),
      'subscribed-message',
      scoped,
    )
    assert.deepStrictEqual(unauthorized, { admitted: false, calls: 0 })

    const outOfScope = slackHooks(
      slackPolicies({
        access: {
          users: { mode: 'all', ids: [] },
          channels: { mode: 'deny', ids: ['C456'] },
          workspaces: { mode: 'all', ids: [] },
        },
        channels: [{ channelId: 'C456', invocationMode: 'all-messages' }],
      }),
      { botUserId: 'U999' },
    )
    const dropped = yield* runAdmit(
      makeSlackInput({ text: 'just chatting' }),
      'subscribed-message',
      outOfScope,
    )
    assert.deepStrictEqual(dropped, { admitted: false, calls: 0 })
  }),
)

it.effect('rejects Slack broadcast and subteam mentions without ingesting', () =>
  Effect.gen(function* () {
    const hooks = slackHooks(slackPolicies(), { botUserId: 'U999' })
    for (const text of [
      'hey <!channel> help',
      'hey <!here> help',
      'hey <!subteam^S123|team> help',
      'hey <@U111> help',
    ]) {
      const dropped = yield* runAdmit(makeSlackInput({ text }), 'subscribed-message', hooks, {
        hasBinding: false,
      })
      assert.deepStrictEqual(dropped, { admitted: false, calls: 0 })
    }
  }),
)

it.effect('drops Slack messages with invalid or out-of-scope locations', () =>
  Effect.gen(function* () {
    const hooks = slackHooks(slackPolicies(), { botUserId: 'U999' })
    const invalid = yield* runAdmit(
      makeSlackInput({ conversationId: 'discord:guild-1:channel-1' }),
      'subscribed-message',
      hooks,
    )
    assert.deepStrictEqual(invalid, { admitted: false, calls: 0 })

    const scoped = slackHooks(
      slackPolicies({
        access: {
          users: { mode: 'all', ids: [] },
          channels: { mode: 'all', ids: [] },
          workspaces: { mode: 'allow', ids: ['T999'] },
        },
      }),
      { botUserId: 'U999' },
    )
    const outOfScope = yield* runAdmit(
      makeSlackInput({ text: 'hey <@U999> help' }),
      'mention',
      scoped,
      { hasBinding: false },
    )
    assert.deepStrictEqual(outOfScope, { admitted: false, calls: 0 })

    const deniedUser = slackHooks(
      slackPolicies({
        access: {
          users: { mode: 'deny', ids: ['U111'] },
          channels: { mode: 'all', ids: [] },
          workspaces: { mode: 'all', ids: [] },
        },
      }),
      { botUserId: 'U999' },
    )
    const unauthorized = yield* runAdmit(
      makeSlackInput({ text: 'hey <@U999> help', userId: 'U111' }),
      'mention',
      deniedUser,
    )
    assert.deepStrictEqual(unauthorized, { admitted: false, calls: 0 })
  }),
)

it.effect('collapses Slack socket redeliveries of the same platform message', () =>
  Effect.gen(function* () {
    const seen = new Set<string>()
    const hooks = slackHooks(slackPolicies(), { botUserId: 'U999', duplicateKeys: seen })
    const first = yield* runAdmit(makeSlackInput({ text: 'hey <@U999> help' }), 'mention', hooks)
    assert.deepStrictEqual(first, { admitted: true, calls: 1 })
    const redelivery = yield* runAdmit(
      makeSlackInput({ text: 'hey <@U999> help' }),
      'mention',
      hooks,
    )
    assert.deepStrictEqual(redelivery, { admitted: false, calls: 0 })
  }),
)

it.effect('propagates binding lookup failures without ingesting', () =>
  Effect.gen(function* () {
    const policy: DiscordTestPolicy = {
      invocationMode: 'mention-only',
      users: { mode: 'all', ids: [] },
    }
    const failure = new Error('binding boom')
    const exit = yield* runAdmit(makeDiscordInput(), 'mention', discordHooks(policy), {
      hasBinding: failure,
    }).pipe(Effect.exit)
    assert.strictEqual(exit._tag, 'Failure')
  }),
)
