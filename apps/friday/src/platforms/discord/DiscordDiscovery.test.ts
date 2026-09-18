import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import type { DiscordThreadId } from '@chat-adapter/discord'
import { Message, type ChannelInfo, type ListThreadsResult, type ThreadSummary } from 'chat'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import {
  PlatformMembersUnsupportedError,
  PlatformTargetNotFoundError,
  type DiscordQueryTarget,
} from '../PlatformAdapter.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'
import {
  canDiscordMemberViewChannel,
  discoverDiscord,
  listDiscordMembers,
  type DiscordDiscoveryAdapter,
  type DiscordDiscoveryPolicy,
  type DiscordGuildMembersOptions,
  type DiscordThreadMembersOptions,
} from './DiscordDiscovery.ts'

const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'message-3',
  conversationId: 'discord:guild-1:channel-1:thread-1',
})

const isTargetNotFound = Schema.is(PlatformTargetNotFoundError)
const isMembersUnsupported = Schema.is(PlatformMembersUnsupportedError)

const admitted = (): DiscordResolvedChannelPolicy => ({
  invocationMode: 'mention-only',
  replyMode: 'reply-in-thread',
  users: { mode: 'all', ids: [] },
})

const policy: DiscordDiscoveryPolicy = {
  resolveChannelPolicy: (guildId, channelId) =>
    guildId === 'guild-1' && (channelId === 'channel-1' || channelId === 'channel-2')
      ? admitted()
      : undefined,
  listGuilds: () => [
    { guildId: 'guild-1', enabled: true, channelIds: ['channel-2', 'channel-denied'] },
    { guildId: 'guild-2', enabled: false, channelIds: [] },
    { guildId: 'guild-3', enabled: true, channelIds: [] },
  ],
}

const threadRaw = (id: string, parentId: string) => ({ id, parent_id: parentId, type: 11 })

const channelNameFor = (encodedId: string): string | undefined => {
  const parts = encodedId.split(':')
  const rawId = parts[3] ?? parts[2]
  if (rawId === 'channel-1') return 'general'
  if (rawId === 'channel-2') return 'random'
  if (rawId === 'thread-9') return 'Thread Nine'
  return undefined
}

const threadMessage = (text: string) =>
  new Message({
    id: 'thread-9',
    threadId: 'discord:guild-1:channel-1:thread-9',
    text,
    formatted: { type: 'root', children: [] },
    raw: {},
    author: { userId: 'user-1', userName: 'user-1', fullName: 'user-1', isBot: false, isMe: false },
    metadata: { dateSent: new Date('2026-03-21T09:00:00.000Z'), edited: false },
    attachments: [],
  })

interface StubMemberRow {
  readonly user_id: string
  readonly member: {
    readonly user: {
      readonly id: string
      readonly username: string
      readonly global_name: string
      readonly bot: boolean
    }
    readonly nick: null
  }
}

interface StubGuildMember {
  readonly user: {
    readonly id: string
    readonly username: string
    readonly global_name: string
    readonly bot: boolean
  }
  readonly nick: null
  readonly roles: ReadonlyArray<string>
}

interface StubOptions {
  readonly threadMembers?: ReadonlyArray<StubMemberRow>
  readonly threads?: Array<{
    readonly id: string
    readonly text: string
    readonly replyCount?: number
  }>
  readonly threadsCursor?: string | undefined
  readonly channelRaw?: unknown
  readonly guildRoles?: ReadonlyArray<unknown>
  readonly guildMembers?: ReadonlyArray<StubGuildMember>
  readonly guildMembersError?: unknown
}

const stubAdapter = (
  options: StubOptions = {},
): DiscordDiscoveryAdapter & {
  readonly memberCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
  }>
  readonly channelCalls: Array<string>
  readonly roleCalls: Array<string>
  readonly guildMemberCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
  }>
} => {
  const memberCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
  }> = []
  const channelCalls: Array<string> = []
  const roleCalls: Array<string> = []
  const guildMemberCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
  }> = []
  return {
    memberCalls,
    channelCalls,
    roleCalls,
    guildMemberCalls,
    decodeThreadId: (id: string): DiscordThreadId => {
      const [, guildId, channelId, threadId] = id.split(':')
      if (guildId === undefined || channelId === undefined) {
        throw new Error(`Malformed Discord conversation id: ${id}`)
      }
      return threadId === undefined ? { guildId, channelId } : { guildId, channelId, threadId }
    },
    encodeThreadId: ({ guildId, channelId, threadId }: DiscordThreadId) =>
      threadId === undefined
        ? `discord:${guildId}:${channelId}`
        : `discord:${guildId}:${channelId}:${threadId}`,
    fetchChannelInfo: (channelId: string) => {
      channelCalls.push(channelId)
      const parts = channelId.split(':')
      const rawId = parts[3] ?? parts[2] ?? ''
      const threadParent = rawId === 'thread-9' ? 'channel-1' : undefined
      const raw =
        threadParent !== undefined
          ? threadRaw(rawId, threadParent)
          : (options.channelRaw ?? { id: rawId, type: 0, permission_overwrites: [] })
      const info: ChannelInfo = {
        id: channelId,
        metadata: { raw },
      }
      const name = channelNameFor(channelId)
      if (name !== undefined) info.name = name
      return Promise.resolve(info)
    },
    listThreads: () => {
      const threads = (options.threads ?? []).map((thread) => {
        const summary: ThreadSummary<unknown> = {
          id: thread.id,
          rootMessage: threadMessage(thread.text),
        }
        if (thread.replyCount !== undefined) summary.replyCount = thread.replyCount
        return summary
      })
      const result: ListThreadsResult<unknown> = { threads }
      if (options.threadsCursor !== undefined) result.nextCursor = options.threadsCursor
      return Promise.resolve(result)
    },
    fetchThreadMembers: (
      _threadId: string,
      fetchOptions: { readonly limit?: number; readonly after?: string } = {},
    ) => {
      const call: DiscordThreadMembersOptions = {}
      if (fetchOptions.limit !== undefined) call.limit = fetchOptions.limit
      if (fetchOptions.after !== undefined) call.after = fetchOptions.after
      memberCalls.push(call)
      const rows = [...(options.threadMembers ?? [])]
      const start =
        fetchOptions.after === undefined
          ? 0
          : rows.findIndex((row) => row.user_id === fetchOptions.after) + 1
      return Promise.resolve(
        fetchOptions.limit === undefined
          ? rows.slice(start)
          : rows.slice(start, start + fetchOptions.limit),
      )
    },
    fetchGuildRoles: (guildId: string) => {
      roleCalls.push(guildId)
      return Promise.resolve([...(options.guildRoles ?? [])])
    },
    fetchGuildMembers: (
      guildId: string,
      fetchOptions: { readonly limit?: number; readonly after?: string } = {},
    ) => {
      const call: DiscordGuildMembersOptions = {}
      if (fetchOptions.limit !== undefined) call.limit = fetchOptions.limit
      if (fetchOptions.after !== undefined) call.after = fetchOptions.after
      guildMemberCalls.push(call)
      if (options.guildMembersError !== undefined) {
        return Promise.reject(options.guildMembersError)
      }
      void guildId
      const rows = [...(options.guildMembers ?? [])]
      const start =
        fetchOptions.after === undefined
          ? 0
          : rows.findIndex((row) => row.user.id === fetchOptions.after) + 1
      return Promise.resolve(
        fetchOptions.limit === undefined
          ? rows.slice(start)
          : rows.slice(start, start + fetchOptions.limit),
      )
    },
  }
}

const guildRole = (id: string, permissions: string) => ({ id, permissions })

const guildMember = (
  userId: string,
  username: string,
  roles: ReadonlyArray<string>,
  bot = false,
): StubGuildMember => ({
  user: { id: userId, username, global_name: username, bot },
  nick: null,
  roles,
})

const channelWithOverwrites = (overwrites: ReadonlyArray<unknown>) => ({
  id: 'channel-1',
  type: 0,
  permission_overwrites: [...overwrites],
})

const overwrite = (id: string, type: 0 | 1, allow: string, deny: string) => ({
  id,
  type,
  allow,
  deny,
})

const memberRow = (
  userId: string,
  username: string,
  displayName: string,
  bot = false,
): StubMemberRow => ({
  user_id: userId,
  member: { user: { id: userId, username, global_name: displayName, bot }, nick: null },
})

const channelTarget: DiscordQueryTarget = {
  platform: 'discord',
  guildId: 'guild-1',
  channelId: 'channel-1',
}

const threadTarget: DiscordQueryTarget = {
  platform: 'discord',
  guildId: 'guild-1',
  channelId: 'channel-1',
  threadId: 'thread-9',
}

it.effect('scopes lists only enabled guilds and marks the current guild', () =>
  Effect.gen(function* () {
    const result = yield* discoverDiscord(
      stubAdapter(),
      {
        binding,
        action: 'scopes',
        limit: 20,
      },
      policy,
    )

    assert.strictEqual(result.action, 'scopes')
    if (result.action !== 'scopes') return
    assert.deepStrictEqual(
      result.scopes.map((scope) => `${scope.kind}:${scope.id}:${scope.isCurrent}`),
      ['guild:guild-1:true', 'guild:guild-3:false'],
    )
    assert.isFalse(result.truncated)
  }),
)

it.effect('scopes filters by query and paginates with an offset cursor', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter()
    const filtered = yield* discoverDiscord(
      adapter,
      {
        binding,
        action: 'scopes',
        query: 'guild-3',
        limit: 20,
      },
      policy,
    )
    assert.strictEqual(filtered.action, 'scopes')
    if (filtered.action !== 'scopes') return
    assert.deepStrictEqual(
      filtered.scopes.map((scope) => scope.id),
      ['guild-3'],
    )

    const first = yield* discoverDiscord(adapter, { binding, action: 'scopes', limit: 1 }, policy)
    assert.strictEqual(first.action, 'scopes')
    if (first.action !== 'scopes' || first.nextCursor === undefined) return
    assert.strictEqual(first.scopes.length, 1)
    assert.isTrue(first.truncated)
    const second = yield* discoverDiscord(
      adapter,
      {
        binding,
        action: 'scopes',
        limit: 1,
        cursor: first.nextCursor,
      },
      policy,
    )
    assert.strictEqual(second.action, 'scopes')
    if (second.action !== 'scopes') return
    assert.strictEqual(second.scopes.length, 1)
    assert.notStrictEqual(first.scopes[0]?.id, second.scopes[0]?.id)
    assert.isFalse(second.truncated)
  }),
)

it.effect('channels lists admitted policy-known channels plus the current channel', () =>
  Effect.gen(function* () {
    const result = yield* discoverDiscord(
      stubAdapter(),
      {
        binding,
        action: 'channels',
        limit: 20,
      },
      policy,
    )

    assert.strictEqual(result.action, 'channels')
    if (result.action !== 'channels') return
    assert.deepStrictEqual(
      result.channels.map((channel) =>
        channel.target.platform === 'discord'
          ? `${channel.target.channelId}:${channel.name}:${channel.isCurrent}`
          : `unexpected:${channel.name}`,
      ),
      ['channel-2:random:false', 'channel-1:general:true'],
    )
  }),
)

it.effect('channels respects the guild filter and the name search', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter()
    const guildFiltered = yield* discoverDiscord(
      adapter,
      {
        binding,
        action: 'channels',
        guildId: 'guild-3',
        limit: 20,
      },
      policy,
    )
    assert.strictEqual(guildFiltered.action, 'channels')
    if (guildFiltered.action !== 'channels') return
    assert.deepStrictEqual(guildFiltered.channels, [])

    const nameSearch = yield* discoverDiscord(
      adapter,
      {
        binding,
        action: 'channels',
        query: 'rand',
        limit: 20,
      },
      policy,
    )
    assert.strictEqual(nameSearch.action, 'channels')
    if (nameSearch.action !== 'channels') return
    assert.deepStrictEqual(
      nameSearch.channels.map((channel) =>
        channel.target.platform === 'discord' ? channel.target.channelId : 'unexpected',
      ),
      ['channel-2'],
    )
  }),
)

it.effect('threads lists threads of an admitted channel with ready targets', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      threads: [
        { id: 'discord:guild-1:channel-1:thread-9', text: 'Thread Nine root', replyCount: 3 },
      ],
    })
    const result = yield* discoverDiscord(
      adapter,
      {
        binding,
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
      platform: 'discord',
      guildId: 'guild-1',
      channelId: 'channel-1',
      threadId: 'thread-9',
    })
    assert.strictEqual(result.threads[0]?.replyCount, 3)
    assert.isFalse(result.threads[0]?.isCurrent ?? true)
  }),
)

it.effect('threads collapses unadmitted parents to not-found', () =>
  Effect.gen(function* () {
    const error = yield* discoverDiscord(
      stubAdapter(),
      {
        binding,
        action: 'threads',
        channelTarget: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
        limit: 20,
      },
      policy,
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
  }),
)

it.effect('lists thread members with minimal safe fields', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      threadMembers: [memberRow('U1', 'alice', 'Alice A'), memberRow('U2', 'botty', 'Botty', true)],
    })
    const result = yield* listDiscordMembers(
      adapter,
      { binding, target: threadTarget, limit: 20 },
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
    assert.deepStrictEqual(adapter.memberCalls[0], { limit: 20 })
  }),
)

it.effect('lists public channel members who can view via @everyone', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelRaw: channelWithOverwrites([]),
      guildRoles: [guildRole('guild-1', '1024')],
      guildMembers: [guildMember('U1', 'alice', []), guildMember('U2', 'bob', [])],
    })
    const result = yield* listDiscordMembers(
      adapter,
      { binding, target: channelTarget, limit: 20 },
      policy,
    )

    assert.deepStrictEqual(
      result.members.map((member) => member.platformUserId),
      ['U1', 'U2'],
    )
    assert.isFalse(result.truncated)
    assert.isUndefined(result.nextCursor)
  }),
)

it.effect('applies role overwrites for allow and deny', () =>
  Effect.gen(function* () {
    const denied = stubAdapter({
      channelRaw: channelWithOverwrites([overwrite('role-1', 0, '0', '1024')]),
      guildRoles: [guildRole('guild-1', '1024'), guildRole('role-1', '0')],
      guildMembers: [guildMember('U1', 'alice', ['role-1']), guildMember('U2', 'bob', [])],
    })
    const deniedResult = yield* listDiscordMembers(
      denied,
      { binding, target: channelTarget, limit: 20 },
      policy,
    )
    assert.deepStrictEqual(
      deniedResult.members.map((member) => member.platformUserId),
      ['U2'],
    )

    const allowed = stubAdapter({
      channelRaw: channelWithOverwrites([overwrite('role-1', 0, '1024', '0')]),
      guildRoles: [guildRole('guild-1', '0'), guildRole('role-1', '0')],
      guildMembers: [guildMember('U1', 'alice', ['role-1']), guildMember('U2', 'bob', [])],
    })
    const allowedResult = yield* listDiscordMembers(
      allowed,
      { binding, target: channelTarget, limit: 20 },
      policy,
    )
    assert.deepStrictEqual(
      allowedResult.members.map((member) => member.platformUserId),
      ['U1'],
    )
  }),
)

it.effect('gives member overwrites precedence over role overwrites', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelRaw: channelWithOverwrites([
        overwrite('role-1', 0, '1024', '0'),
        overwrite('U1', 1, '0', '1024'),
        overwrite('U3', 1, '1024', '0'),
      ]),
      guildRoles: [guildRole('guild-1', '0'), guildRole('role-1', '0'), guildRole('role-2', '0')],
      guildMembers: [
        guildMember('U1', 'alice', ['role-1']),
        guildMember('U2', 'bob', ['role-1']),
        guildMember('U3', 'cara', ['role-2']),
      ],
    })
    const result = yield* listDiscordMembers(
      adapter,
      { binding, target: channelTarget, limit: 20 },
      policy,
    )

    assert.deepStrictEqual(
      result.members.map((member) => member.platformUserId),
      ['U2', 'U3'],
    )
  }),
)

it.effect('lets administrators view despite deny overwrites', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelRaw: channelWithOverwrites([overwrite('guild-1', 0, '0', '1024')]),
      guildRoles: [guildRole('guild-1', '0'), guildRole('role-admin', '8')],
      guildMembers: [guildMember('U1', 'admin', ['role-admin']), guildMember('U2', 'bob', [])],
    })
    const result = yield* listDiscordMembers(
      adapter,
      { binding, target: channelTarget, limit: 20 },
      policy,
    )

    assert.deepStrictEqual(
      result.members.map((member) => member.platformUserId),
      ['U1'],
    )
    assert.isTrue(
      canDiscordMemberViewChannel({
        guildId: 'guild-1',
        memberId: 'U1',
        memberRoleIds: ['role-admin'],
        rolesById: new Map([
          ['guild-1', 0n],
          ['role-admin', 8n],
        ]),
        overwrites: [{ id: 'guild-1', type: 0, allow: '0', deny: '1024' }],
      }),
    )
  }),
)

it.effect('paginates channel members with an opaque after cursor', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelRaw: channelWithOverwrites([]),
      guildRoles: [guildRole('guild-1', '1024')],
      guildMembers: [
        guildMember('U1', 'alice', []),
        guildMember('U2', 'bob', []),
        guildMember('U3', 'cara', []),
      ],
    })
    const first = yield* listDiscordMembers(
      adapter,
      { binding, target: channelTarget, limit: 2 },
      policy,
    )
    assert.deepStrictEqual(
      first.members.map((member) => member.platformUserId),
      ['U1', 'U2'],
    )
    assert.isTrue(first.truncated)
    assert.strictEqual(first.nextCursor, 'U2')

    const second = yield* listDiscordMembers(
      adapter,
      { binding, target: channelTarget, limit: 2, cursor: first.nextCursor },
      policy,
    )
    assert.deepStrictEqual(
      second.members.map((member) => member.platformUserId),
      ['U3'],
    )
    assert.isFalse(second.truncated)
    assert.isUndefined(second.nextCursor)
  }),
)

it.effect('returns bots with minimal safe fields only', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelRaw: channelWithOverwrites([]),
      guildRoles: [guildRole('guild-1', '1024')],
      guildMembers: [guildMember('U1', 'alice', []), guildMember('B1', 'botty', [], true)],
    })
    const result = yield* listDiscordMembers(
      adapter,
      { binding, target: channelTarget, limit: 20 },
      policy,
    )

    assert.strictEqual(result.members.length, 2)
    assert.deepStrictEqual(result.members[1], {
      platformUserId: 'B1',
      username: 'botty',
      displayName: 'botty',
      mention: '<@B1>',
      isBot: true,
    })
    for (const member of result.members) {
      assert.deepStrictEqual(Object.keys(member).sort(), [
        'displayName',
        'isBot',
        'mention',
        'platformUserId',
        'username',
      ])
    }
  }),
)

it.effect('fails cleanly when guild member enumeration is unavailable', () =>
  Effect.gen(function* () {
    const error = yield* listDiscordMembers(
      stubAdapter({
        channelRaw: channelWithOverwrites([]),
        guildRoles: [guildRole('guild-1', '1024')],
        guildMembersError: new Error('Discord API error: 403 Missing Access'),
      }),
      { binding, target: channelTarget, limit: 20 },
      policy,
    ).pipe(Effect.flip)

    assert(isMembersUnsupported(error))
    assert.include(error.detail, 'Server Members')
  }),
)

it.effect('makes no adapter call for policy-denied channel targets', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelRaw: channelWithOverwrites([]),
      guildRoles: [guildRole('guild-1', '1024')],
      guildMembers: [guildMember('U1', 'alice', [])],
    })
    const error = yield* listDiscordMembers(
      adapter,
      {
        binding,
        target: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
        limit: 20,
      },
      policy,
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
    assert.deepStrictEqual(adapter.channelCalls, [])
    assert.deepStrictEqual(adapter.roleCalls, [])
    assert.deepStrictEqual(adapter.guildMemberCalls, [])
  }),
)

it.effect('collapses unadmitted thread parents and DMs to not-found', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({ threadMembers: [memberRow('U1', 'alice', 'Alice A')] })
    const unadmitted = yield* listDiscordMembers(
      adapter,
      {
        binding,
        target: {
          platform: 'discord',
          guildId: 'guild-9',
          channelId: 'channel-9',
          threadId: 'thread-9',
        },
        limit: 20,
      },
      policy,
    ).pipe(Effect.flip)
    assert(isTargetNotFound(unadmitted))

    const direct = yield* listDiscordMembers(
      adapter,
      {
        binding,
        target: { platform: 'discord', guildId: '@me', channelId: 'dm-1', threadId: 'thread-9' },
        limit: 20,
      },
      policy,
    ).pipe(Effect.flip)
    assert(isTargetNotFound(direct))
  }),
)
