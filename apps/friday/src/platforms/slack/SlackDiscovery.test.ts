import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import { Message, type ListThreadsResult, type ThreadSummary } from 'chat'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  PlatformMembersUnsupportedError,
  PlatformTargetNotFoundError,
  type SlackQueryTarget,
} from '../PlatformAdapter.ts'
import {
  discoverSlack,
  listSlackMembers,
  type SlackChannelMembersArgs,
  type SlackDiscoveryAdapter,
  type SlackDiscoveryPolicy,
} from './SlackDiscovery.ts'

const channelBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'slack',
  connectionId: 'slack-personal',
  channelId: 'slack:T123:C456',
  sourceMessageId: '1234567890.111111',
  conversationId: 'slack:T123:C456',
  scopeId: 'T123',
})

const threadBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'slack',
  connectionId: 'slack-personal',
  channelId: 'slack:T123:C456',
  sourceMessageId: '1234567890.222222',
  conversationId: 'slack:T123:C456:1234567890.111111',
  scopeId: 'T123',
})

const isTargetNotFound = Schema.is(PlatformTargetNotFoundError)
const isMembersUnsupported = Schema.is(PlatformMembersUnsupportedError)

const policy: SlackDiscoveryPolicy = {
  workspaceId: 'T123',
}

const channelTarget: SlackQueryTarget = {
  platform: 'slack',
  workspaceId: 'T123',
  channelId: 'C456',
}

const threadTarget: SlackQueryTarget = {
  platform: 'slack',
  workspaceId: 'T123',
  channelId: 'C456',
  threadTs: '1234567890.111111',
}

const slackError = (code: string) => ({ data: { error: code } })

interface StubUserProfile {
  readonly username: string
  readonly displayName: string
  readonly bot: boolean
}

interface StubOptions {
  readonly memberIds?: ReadonlyArray<string>
  readonly membersCursor?: string | undefined
  readonly membersError?: string | undefined
  readonly userProfiles?: Readonly<Record<string, StubUserProfile>>
  readonly userError?: string | undefined
  readonly threads?: Array<{
    readonly ts: string
    readonly text: string
    readonly replyCount?: number
  }>
  readonly channelNames?: Record<string, string>
}

const stubAdapter = (
  options: StubOptions = {},
): SlackDiscoveryAdapter & {
  readonly memberCalls: Array<{ readonly channel: string; readonly cursor?: string | undefined }>
  readonly userCalls: Array<string>
} => {
  const memberCalls: Array<{ readonly channel: string; readonly cursor?: string | undefined }> = []
  const userCalls: Array<string> = []
  return {
    memberCalls,
    userCalls,
    fetchChannelInfo: (channelId: string) => {
      const channel = channelId.split(':')[1] ?? channelId
      return Promise.resolve({
        id: channelId,
        name: options.channelNames?.[channel] ?? channel,
        metadata: {},
      })
    },
    listThreads: () => {
      const threads = (options.threads ?? []).map((thread) => {
        const summary: ThreadSummary<unknown> = {
          id: `slack:C456:${thread.ts}`,
          rootMessage: new Message({
            id: thread.ts,
            threadId: `slack:C456:${thread.ts}`,
            text: thread.text,
            formatted: { type: 'root', children: [] },
            raw: {},
            author: {
              userId: 'U1',
              userName: 'U1',
              fullName: 'U1',
              isBot: false,
              isMe: false,
            },
            metadata: { dateSent: new Date(0), edited: false },
            attachments: [],
          }),
        }
        if (thread.replyCount !== undefined) summary.replyCount = thread.replyCount
        return summary
      })
      const result: ListThreadsResult<unknown> = { threads }
      if (options.membersCursor !== undefined) result.nextCursor = options.membersCursor
      return Promise.resolve(result)
    },
    webClient: {
      conversations: {
        list: () =>
          Promise.resolve({
            channels: [{ id: 'C456', name: options.channelNames?.['C456'] ?? 'general' }],
            response_metadata: {},
          }),
        members: (args: { readonly channel: string; readonly cursor?: string }) => {
          const call: SlackChannelMembersArgs = { channel: args.channel }
          if (args.cursor !== undefined) call.cursor = args.cursor
          memberCalls.push(call)
          if (options.membersError !== undefined) {
            return Promise.reject(slackError(options.membersError))
          }
          return Promise.resolve({
            members: [...(options.memberIds ?? [])],
            response_metadata: { next_cursor: options.membersCursor ?? '' },
          })
        },
      },
      users: {
        info: (args: { readonly user: string }) => {
          userCalls.push(args.user)
          if (options.userError !== undefined) {
            return Promise.reject(slackError(options.userError))
          }
          const profile = options.userProfiles?.[args.user]
          if (profile === undefined) {
            return Promise.resolve({
              user: { id: args.user, name: args.user.toLowerCase() },
            })
          }
          return Promise.resolve({
            user: {
              id: args.user,
              name: profile.username,
              profile: { display_name: profile.displayName },
              is_bot: profile.bot,
            },
          })
        },
      },
    },
  }
}

it.effect('returns the current conversation as a ready target on the bound workspace', () =>
  Effect.gen(function* () {
    const channel = yield* discoverSlack(
      stubAdapter(),
      {
        binding: channelBinding,
        action: 'current',
        limit: 20,
      },
      policy,
    )
    assert.strictEqual(channel.action, 'current')
    if (channel.action !== 'current') return
    assert.strictEqual(channel.workspaceId, 'T123')
    assert.deepStrictEqual(channel.current.target, {
      platform: 'slack',
      workspaceId: 'T123',
      channelId: 'C456',
    })

    const threaded = yield* discoverSlack(
      stubAdapter(),
      {
        binding: threadBinding,
        action: 'current',
        limit: 20,
      },
      policy,
    )
    assert.strictEqual(threaded.action, 'current')
    if (threaded.action !== 'current') return
    assert.deepStrictEqual(threaded.current.target, {
      platform: 'slack',
      workspaceId: 'T123',
      channelId: 'C456',
      threadTs: '1234567890.111111',
    })
  }),
)

it.effect('scopes returns only the bound workspace', () =>
  Effect.gen(function* () {
    const result = yield* discoverSlack(
      stubAdapter(),
      {
        binding: channelBinding,
        action: 'scopes',
        limit: 20,
      },
      policy,
    )

    assert.strictEqual(result.action, 'scopes')
    if (result.action !== 'scopes') return
    assert.deepStrictEqual(result.scopes, [{ kind: 'workspace', id: 'T123', isCurrent: true }])
  }),
)

it.effect('channels lists bot-visible workspace channels', () =>
  Effect.gen(function* () {
    const result = yield* discoverSlack(
      stubAdapter({ channelNames: { C456: 'general', D789: 'direct' } }),
      { binding: channelBinding, action: 'channels', limit: 20 },
      policy,
    )

    assert.strictEqual(result.action, 'channels')
    if (result.action !== 'channels') return
    // Only bot-visible channels from conversations.list appear.
    assert.deepStrictEqual(
      result.channels.map((channel) =>
        channel.target.platform === 'slack' ? channel.target.channelId : 'unexpected',
      ),
      ['C456'],
    )
    assert.strictEqual(result.channels[0]?.name, 'general')
    assert.isTrue(result.channels[0]?.isCurrent ?? false)
  }),
)

it.effect('lists channel members with profile names', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      memberIds: ['U1', 'U2'],
      userProfiles: {
        U1: { username: 'alice', displayName: 'Alice A', bot: false },
        U2: { username: 'botty', displayName: 'botty', bot: true },
      },
    })
    const result = yield* listSlackMembers(
      adapter,
      { binding: channelBinding, target: channelTarget, limit: 20 },
      policy,
    )

    assert.strictEqual(result.members.length, 2)
    assert.deepStrictEqual(result.members[0], {
      platformUserId: 'U1',
      username: 'alice',
      displayName: 'Alice A',
      mention: '<@U1>',
      isBot: false,
    })
    assert.strictEqual(result.members[1]?.isBot, true)
    assert.deepStrictEqual(adapter.memberCalls, [{ channel: 'C456' }])
  }),
)

it.effect('falls back to IDs-only entries when the profile scope is missing', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({ memberIds: ['U1', 'U2'], userError: 'missing_scope' })
    const result = yield* listSlackMembers(
      adapter,
      { binding: channelBinding, target: channelTarget, limit: 20 },
      policy,
    )

    assert.deepStrictEqual(
      result.members.map((member) => member.displayName),
      ['U1', 'U2'],
    )
    assert.strictEqual(result.members[0]?.isBot, 'unknown')
    // One failed lookup disables the rest instead of burning a call per member.
    assert.strictEqual(adapter.userCalls.length, 1)
  }),
)

it.effect('lists parent channel members for thread targets', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({ memberIds: ['U1'] })
    const result = yield* listSlackMembers(
      adapter,
      { binding: threadBinding, target: threadTarget, limit: 20 },
      policy,
    )

    assert.strictEqual(result.members.length, 1)
    assert.deepStrictEqual(adapter.memberCalls, [{ channel: 'C456' }])
  }),
)

it.effect('collapses workspace mismatches and inaccessible channels to not-found', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({ memberIds: ['U1'] })
    const mismatch = yield* listSlackMembers(
      adapter,
      {
        binding: channelBinding,
        target: { platform: 'slack', workspaceId: 'T999', channelId: 'C456' },
        limit: 20,
      },
      policy,
    ).pipe(Effect.flip)
    assert(isTargetNotFound(mismatch))

    const visible = yield* listSlackMembers(
      adapter,
      {
        binding: channelBinding,
        target: { platform: 'slack', workspaceId: 'T123', channelId: 'C000' },
        limit: 20,
      },
      policy,
    )
    assert.strictEqual(visible.members.length, 1)

    const inaccessible = yield* listSlackMembers(
      stubAdapter({ membersError: 'channel_not_found' }),
      {
        binding: channelBinding,
        target: { platform: 'slack', workspaceId: 'T123', channelId: 'C000' },
        limit: 20,
      },
      policy,
    ).pipe(Effect.flip)
    assert(isTargetNotFound(inaccessible))
  }),
)

it.effect('threads lists thread targets of a visible channel', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      threads: [{ ts: '1234567890.111111', text: 'Root question', replyCount: 2 }],
    })
    const result = yield* discoverSlack(
      adapter,
      {
        binding: channelBinding,
        action: 'threads',
        channelTarget,
        limit: 20,
      },
      policy,
    )

    assert.strictEqual(result.action, 'threads')
    if (result.action !== 'threads') return
    assert.strictEqual(result.threads.length, 1)
    assert.deepStrictEqual(result.threads[0]?.target, {
      platform: 'slack',
      workspaceId: 'T123',
      channelId: 'C456',
      threadTs: '1234567890.111111',
    })
    assert.strictEqual(result.threads[0]?.replyCount, 2)
  }),
)

it.effect('threads requires a channel target and collapses inaccessible parents', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter()
    const threadParent = yield* discoverSlack(
      adapter,
      { binding: channelBinding, action: 'threads', channelTarget: threadTarget, limit: 20 },
      policy,
    ).pipe(Effect.flip)
    assert(isMembersUnsupported(threadParent))

    const visible = yield* discoverSlack(
      adapter,
      {
        binding: channelBinding,
        action: 'threads',
        channelTarget: { platform: 'slack', workspaceId: 'T123', channelId: 'C000' },
        limit: 20,
      },
      policy,
    )
    assert.strictEqual(visible.action, 'threads')
  }),
)
