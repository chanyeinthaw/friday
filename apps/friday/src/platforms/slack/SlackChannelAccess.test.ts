import { assert, it } from '@effect/vitest'
import * as Option from 'effect/Option'

import {
  containsDirectMention,
  isSlackDirectMessageChannel,
  replyInChannelSlackChannelIds,
  resolveSlackChannelPolicy,
  shouldInvokeSlack,
  type SlackConnectionPolicies,
} from './SlackChannelAccess.ts'

const policies = (overrides: Partial<SlackConnectionPolicies> = {}): SlackConnectionPolicies => ({
  access: {
    users: { mode: 'all', ids: [] },
    channels: { mode: 'all', ids: [] },
    workspaces: { mode: 'all', ids: [] },
  },
  defaultReplyMode: 'reply-in-thread',
  channels: [],
  ...overrides,
})

it('admits admitted workspaces and channels', () => {
  const resolved = resolveSlackChannelPolicy(policies(), 'T123', 'C456')
  if (Option.isNone(resolved)) assert.fail('expected a resolved policy')
  assert.strictEqual(resolved.value.replyMode, 'reply-in-thread')
  assert.strictEqual(resolved.value.invocationMode, 'mention-only')
})

it('resolves channel reply overrides without granting admission', () => {
  const resolved = resolveSlackChannelPolicy(
    policies({ channels: [{ channelId: 'C456', replyMode: 'reply-in-channel' }] }),
    'T123',
    'C456',
  )
  if (Option.isNone(resolved)) assert.fail('expected a resolved policy')
  assert.strictEqual(resolved.value.replyMode, 'reply-in-channel')
  assert.strictEqual(resolved.value.invocationMode, 'mention-only')
})

it('resolves channel invocation overrides without granting admission', () => {
  const resolved = resolveSlackChannelPolicy(
    policies({ channels: [{ channelId: 'C456', invocationMode: 'all-messages' }] }),
    'T123',
    'C456',
  )
  if (Option.isNone(resolved)) assert.fail('expected a resolved policy')
  assert.strictEqual(resolved.value.invocationMode, 'all-messages')
  assert.strictEqual(resolved.value.replyMode, 'reply-in-thread')
})

it('resolves combined invocation and reply overrides from one row', () => {
  const resolved = resolveSlackChannelPolicy(
    policies({
      channels: [
        {
          channelId: 'C456',
          invocationMode: 'all-messages',
          replyMode: 'reply-in-channel',
        },
      ],
    }),
    'T123',
    'C456',
  )
  if (Option.isNone(resolved)) assert.fail('expected a resolved policy')
  assert.strictEqual(resolved.value.invocationMode, 'all-messages')
  assert.strictEqual(resolved.value.replyMode, 'reply-in-channel')
})

it('resolves the override from the matching channel row', () => {
  const resolved = resolveSlackChannelPolicy(
    policies({
      channels: [
        { channelId: 'C000', replyMode: 'reply-in-thread' },
        { channelId: 'C456', replyMode: 'reply-in-channel' },
      ],
    }),
    'T123',
    'C456',
  )
  if (Option.isNone(resolved)) assert.fail('expected a resolved policy')
  assert.strictEqual(resolved.value.replyMode, 'reply-in-channel')
})

it('lists only channels configured to reply in channel', () => {
  assert.deepStrictEqual(
    replyInChannelSlackChannelIds(
      policies({
        channels: [
          { channelId: 'C111', replyMode: 'reply-in-channel' },
          { channelId: 'C222', replyMode: 'reply-in-thread' },
          { channelId: 'C333', replyMode: 'reply-in-channel' },
        ],
      }),
    ),
    ['C111', 'C333'],
  )
  assert.deepStrictEqual(replyInChannelSlackChannelIds(policies()), [])
})

it('fails closed for workspaces outside the scope', () => {
  const resolved = resolveSlackChannelPolicy(
    policies({
      access: {
        users: { mode: 'all', ids: [] },
        channels: { mode: 'all', ids: [] },
        workspaces: { mode: 'allow', ids: ['T999'] },
      },
    }),
    'T123',
    'C456',
  )
  assert.strictEqual(Option.isNone(resolved), true)
})

it('fails closed for channels outside the scope', () => {
  const resolved = resolveSlackChannelPolicy(
    policies({
      access: {
        users: { mode: 'all', ids: [] },
        channels: { mode: 'deny', ids: ['C456'] },
        workspaces: { mode: 'all', ids: [] },
      },
    }),
    'T123',
    'C456',
  )
  assert.strictEqual(Option.isNone(resolved), true)
})

it('detects only direct bot mentions', () => {
  assert.strictEqual(containsDirectMention('hey <@U999> help', 'U999'), true)
  assert.strictEqual(containsDirectMention('hey <!channel> help', 'U999'), false)
  assert.strictEqual(containsDirectMention('hey <!here> help', 'U999'), false)
  assert.strictEqual(containsDirectMention('hey <!subteam^S123|team> help', 'U999'), false)
  assert.strictEqual(containsDirectMention('hey <@U111> help', 'U999'), false)
  assert.strictEqual(containsDirectMention('anything', ''), false)
  // An empty bot id never matches, even when the text carries a bare mention.
  assert.strictEqual(containsDirectMention('hey <@> help', ''), false)
})

it('invokes on direct messages, bound threads, and direct mentions only', () => {
  assert.strictEqual(
    shouldInvokeSlack({ isDirectMessage: true, hasBinding: false, isDirectMention: false }),
    true,
  )
  assert.strictEqual(
    shouldInvokeSlack({ isDirectMessage: false, hasBinding: true, isDirectMention: false }),
    true,
  )
  assert.strictEqual(
    shouldInvokeSlack({ isDirectMessage: false, hasBinding: false, isDirectMention: true }),
    true,
  )
  assert.strictEqual(
    shouldInvokeSlack({ isDirectMessage: false, hasBinding: false, isDirectMention: false }),
    false,
  )
})

it('invokes channel and native-thread chatter without a mention in all-messages channels', () => {
  assert.strictEqual(
    shouldInvokeSlack({
      isDirectMessage: false,
      hasBinding: false,
      isDirectMention: false,
      invocationMode: 'all-messages',
    }),
    true,
  )
  // `@channel`, `@here`, and user-group mentions arrive with
  // `isDirectMention: false`; in an all-messages channel the containing
  // message still invokes because of the channel mode, not mention parsing.
  // User-created native-thread replies invoke without a mention or a bound
  // thread, matching Discord manual-thread parity; bound and mentioned
  // thread replies keep invoking.
  assert.strictEqual(
    shouldInvokeSlack({
      isDirectMessage: false,
      hasBinding: false,
      isDirectMention: false,
      invocationMode: 'all-messages',
    }),
    true,
  )
  assert.strictEqual(
    shouldInvokeSlack({
      isDirectMessage: false,
      hasBinding: true,
      isDirectMention: false,
      invocationMode: 'all-messages',
    }),
    true,
  )
  assert.strictEqual(
    shouldInvokeSlack({
      isDirectMessage: false,
      hasBinding: false,
      isDirectMention: true,
      invocationMode: 'all-messages',
    }),
    true,
  )
  // Mention-only stays the default: unmentioned chatter drops without a
  // bound thread, in channels and in native threads.
  assert.strictEqual(
    shouldInvokeSlack({
      isDirectMessage: false,
      hasBinding: false,
      isDirectMention: false,
      invocationMode: 'mention-only',
    }),
    false,
  )
  assert.strictEqual(
    shouldInvokeSlack({
      isDirectMessage: false,
      hasBinding: true,
      isDirectMention: false,
      invocationMode: 'mention-only',
    }),
    true,
  )
})

it('recognizes direct message channels', () => {
  assert.strictEqual(isSlackDirectMessageChannel('D123'), true)
  assert.strictEqual(isSlackDirectMessageChannel('C123'), false)
  assert.strictEqual(isSlackDirectMessageChannel('G123'), false)
})
