import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import type { DiscordThreadId } from '@chat-adapter/discord'
import { Message, type ChannelInfo, type ListThreadsResult, type ThreadSummary } from 'chat'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import {
  PlatformMembersUnsupportedError,
  PlatformTargetNotFoundError,
  type DiscordQueryTarget,
} from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import {
  canDiscordMemberViewChannel,
  discoverDiscord,
  listDiscordMembers,
  type DiscordBotGuildsOptions,
  type DiscordDiscoveryAdapter,
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
const isPublicationError = Schema.is(ChatSdkPublicationError)

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
  readonly threadMembersError?: unknown
  readonly threads?: Array<{
    readonly id: string
    readonly text: string
    readonly replyCount?: number
  }>
  readonly threadsCursor?: string | undefined
  readonly channelRaw?: unknown
  readonly channelError?: unknown
  readonly guildRaw?: unknown
  readonly guildOwnerId?: string | undefined
  readonly guildError?: unknown
  readonly guildRoles?: ReadonlyArray<unknown>
  readonly guildRolesError?: unknown
  readonly guildMembers?: ReadonlyArray<StubGuildMember>
  readonly guildMembersRaw?: ReadonlyArray<unknown>
  readonly guildMembersError?: unknown
  readonly botGuilds?: ReadonlyArray<{ readonly id: string; readonly name?: string }>
  readonly botGuildsError?: unknown
  readonly guildChannels?: Record<
    string,
    ReadonlyArray<{ readonly id: string; readonly name?: string; readonly type?: number }>
  >
  readonly guildChannelsError?: unknown
}

const stubAdapter = (
  options: StubOptions = {},
): DiscordDiscoveryAdapter & {
  readonly memberCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
  }>
  readonly channelCalls: Array<string>
  readonly guildCalls: Array<string>
  readonly roleCalls: Array<string>
  readonly guildMemberCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
  }>
  readonly botGuildCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
    readonly before?: string | undefined
  }>
} => {
  const memberCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
  }> = []
  const channelCalls: Array<string> = []
  const guildCalls: Array<string> = []
  const roleCalls: Array<string> = []
  const guildMemberCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
  }> = []
  const botGuildCalls: Array<{
    readonly limit?: number | undefined
    readonly after?: string | undefined
    readonly before?: string | undefined
  }> = []
  const GuildUserIdRaw = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) })
  const decodeGuildUserId = Schema.decodeUnknownOption(GuildUserIdRaw)
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test stub paginates untrusted REST-shaped rows like the adapter boundary.
  const guildUserIdOf = (row: unknown): string | undefined =>
    Option.getOrUndefined(decodeGuildUserId(row))?.user.id
  return {
    memberCalls,
    channelCalls,
    guildCalls,
    roleCalls,
    guildMemberCalls,
    botGuildCalls,
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
      if (options.channelError !== undefined) {
        return Promise.reject(options.channelError)
      }
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
      if (options.threadMembersError !== undefined) {
        return Promise.reject(options.threadMembersError)
      }
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
    fetchGuild: (guildId: string) => {
      guildCalls.push(guildId)
      if (options.guildError !== undefined) {
        return Promise.reject(options.guildError)
      }
      if (options.guildRaw !== undefined) return Promise.resolve(options.guildRaw)
      return Promise.resolve({ id: guildId, owner_id: options.guildOwnerId ?? 'owner-0' })
    },
    fetchGuildRoles: (guildId: string) => {
      roleCalls.push(guildId)
      if (options.guildRolesError !== undefined) {
        return Promise.reject(options.guildRolesError)
      }
      return Promise.resolve([...(options.guildRoles ?? [])])
    },
    fetchBotGuilds: (
      fetchOptions: {
        readonly limit?: number
        readonly after?: string
        readonly before?: string
      } = {},
    ) => {
      const call: DiscordBotGuildsOptions = {}
      if (fetchOptions.limit !== undefined) call.limit = fetchOptions.limit
      if (fetchOptions.after !== undefined) call.after = fetchOptions.after
      if (fetchOptions.before !== undefined) call.before = fetchOptions.before
      botGuildCalls.push({ ...call })
      if (options.botGuildsError !== undefined) {
        return Promise.reject(options.botGuildsError)
      }
      const all = options.botGuilds ?? [
        { id: 'guild-1', name: 'Guild One' },
        { id: 'guild-3', name: 'Guild Three' },
      ]
      // Native `after`/`before` pagination over guild ids, honouring `limit`.
      let rows = [...all]
      if (fetchOptions.after !== undefined) {
        const index = rows.findIndex((guild) => guild.id === fetchOptions.after)
        rows = index < 0 ? [] : rows.slice(index + 1)
      }
      if (fetchOptions.before !== undefined) {
        const index = rows.findIndex((guild) => guild.id === fetchOptions.before)
        rows = index < 0 ? [] : rows.slice(0, index)
      }
      if (fetchOptions.limit !== undefined) rows = rows.slice(0, fetchOptions.limit)
      return Promise.resolve(rows)
    },
    fetchGuildChannels: (guildId: string) => {
      if (options.guildChannelsError !== undefined) {
        return Promise.reject(options.guildChannelsError)
      }
      if (options.guildChannels !== undefined) {
        return Promise.resolve([...(options.guildChannels[guildId] ?? [])])
      }
      if (guildId === 'guild-1') {
        return Promise.resolve([
          { id: 'channel-1', name: 'general', type: 0 },
          { id: 'channel-2', name: 'random', type: 0 },
        ])
      }
      return Promise.resolve([])
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
      const rows: ReadonlyArray<unknown> =
        options.guildMembersRaw !== undefined
          ? [...options.guildMembersRaw]
          : [...(options.guildMembers ?? [])]
      const start =
        fetchOptions.after === undefined
          ? 0
          : rows.findIndex((row) => guildUserIdOf(row) === fetchOptions.after) + 1
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

it.effect('scopes lists bot-visible guilds and marks the current guild', () =>
  Effect.gen(function* () {
    const result = yield* discoverDiscord(stubAdapter(), {
      binding,
      action: 'scopes',
      limit: 20,
    })

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
    const filtered = yield* discoverDiscord(adapter, {
      binding,
      action: 'scopes',
      query: 'guild-3',
      limit: 20,
    })
    assert.strictEqual(filtered.action, 'scopes')
    if (filtered.action !== 'scopes') return
    assert.deepStrictEqual(
      filtered.scopes.map((scope) => scope.id),
      ['guild-3'],
    )

    const first = yield* discoverDiscord(adapter, { binding, action: 'scopes', limit: 1 })
    assert.strictEqual(first.action, 'scopes')
    if (first.action !== 'scopes' || first.nextCursor === undefined) return
    assert.strictEqual(first.scopes.length, 1)
    assert.isTrue(first.truncated)
    const second = yield* discoverDiscord(adapter, {
      binding,
      action: 'scopes',
      limit: 1,
      cursor: first.nextCursor,
    })
    assert.strictEqual(second.action, 'scopes')
    if (second.action !== 'scopes') return
    assert.strictEqual(second.scopes.length, 1)
    assert.notStrictEqual(first.scopes[0]?.id, second.scopes[0]?.id)
    assert.isFalse(second.truncated)
  }),
)

it.effect('channels lists bot-visible guild channels', () =>
  Effect.gen(function* () {
    const result = yield* discoverDiscord(stubAdapter(), {
      binding,
      action: 'channels',
      limit: 20,
    })

    assert.strictEqual(result.action, 'channels')
    if (result.action !== 'channels') return
    assert.deepStrictEqual(
      result.channels.map((channel) =>
        channel.target.platform === 'discord'
          ? `${channel.target.channelId}:${channel.name}:${channel.isCurrent}`
          : `unexpected:${channel.name}`,
      ),
      ['channel-1:general:true', 'channel-2:random:false'],
    )
  }),
)

it.effect('channels respects the guild filter and the name search', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter()
    const guildFiltered = yield* discoverDiscord(adapter, {
      binding,
      action: 'channels',
      guildId: 'guild-3',
      limit: 20,
    })
    assert.strictEqual(guildFiltered.action, 'channels')
    if (guildFiltered.action !== 'channels') return
    assert.deepStrictEqual(guildFiltered.channels, [])

    const nameSearch = yield* discoverDiscord(adapter, {
      binding,
      action: 'channels',
      query: 'rand',
      limit: 20,
    })
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
    const result = yield* discoverDiscord(adapter, {
      binding,
      action: 'threads',
      channelTarget,
      limit: 20,
    })

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

it.effect('threads collapses inaccessible parents to not-found', () =>
  Effect.gen(function* () {
    const error = yield* discoverDiscord(
      stubAdapter({ channelError: new Error('Discord API error: 404 Unknown Channel') }),
      {
        binding,
        action: 'threads',
        channelTarget: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
        limit: 20,
      },
    ).pipe(Effect.flip)

    assert(isTargetNotFound(error))
  }),
)

it.effect('lists thread members with minimal safe fields', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      threadMembers: [memberRow('U1', 'alice', 'Alice A'), memberRow('U2', 'botty', 'Botty', true)],
    })
    const result = yield* listDiscordMembers(adapter, { binding, target: threadTarget, limit: 20 })

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
    const result = yield* listDiscordMembers(adapter, { binding, target: channelTarget, limit: 20 })

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
    const deniedResult = yield* listDiscordMembers(denied, {
      binding,
      target: channelTarget,
      limit: 20,
    })
    assert.deepStrictEqual(
      deniedResult.members.map((member) => member.platformUserId),
      ['U2'],
    )

    const allowed = stubAdapter({
      channelRaw: channelWithOverwrites([overwrite('role-1', 0, '1024', '0')]),
      guildRoles: [guildRole('guild-1', '0'), guildRole('role-1', '0')],
      guildMembers: [guildMember('U1', 'alice', ['role-1']), guildMember('U2', 'bob', [])],
    })
    const allowedResult = yield* listDiscordMembers(allowed, {
      binding,
      target: channelTarget,
      limit: 20,
    })
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
    const result = yield* listDiscordMembers(adapter, { binding, target: channelTarget, limit: 20 })

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
    const result = yield* listDiscordMembers(adapter, { binding, target: channelTarget, limit: 20 })

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
    const first = yield* listDiscordMembers(adapter, { binding, target: channelTarget, limit: 2 })
    assert.deepStrictEqual(
      first.members.map((member) => member.platformUserId),
      ['U1', 'U2'],
    )
    assert.isTrue(first.truncated)
    assert.strictEqual(first.nextCursor, 'U2')

    const second = yield* listDiscordMembers(adapter, {
      binding,
      target: channelTarget,
      limit: 2,
      cursor: first.nextCursor,
    })
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
    const result = yield* listDiscordMembers(adapter, { binding, target: channelTarget, limit: 20 })

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
    ).pipe(Effect.flip)

    assert(isMembersUnsupported(error))
    assert.include(error.detail, 'Server Members')
  }),
)

it.effect('collapses inaccessible channel targets to not-found', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelError: new Error('Discord API error: 404 Unknown Channel'),
    })
    const error = yield* listDiscordMembers(adapter, {
      binding,
      target: { platform: 'discord', guildId: 'guild-9', channelId: 'channel-9' },
      limit: 20,
    }).pipe(Effect.flip)

    assert(isTargetNotFound(error))
    assert.isTrue(adapter.channelCalls.length > 0)
  }),
)

it.effect('collapses inaccessible thread parents and DMs to not-found', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelError: new Error('Discord API error: 404 Unknown Channel'),
      threadMembers: [memberRow('U1', 'alice', 'Alice A')],
    })
    const unadmitted = yield* listDiscordMembers(adapter, {
      binding,
      target: {
        platform: 'discord',
        guildId: 'guild-9',
        channelId: 'channel-9',
        threadId: 'thread-9',
      },
      limit: 20,
    }).pipe(Effect.flip)
    assert(isTargetNotFound(unadmitted))

    const direct = yield* listDiscordMembers(adapter, {
      binding,
      target: { platform: 'discord', guildId: '@me', channelId: 'dm-1', threadId: 'thread-9' },
      limit: 20,
    }).pipe(Effect.flip)
    assert(isTargetNotFound(direct))
  }),
)

const structuredRestError = (status: number, message: string): Error => {
  const original = Object.assign(new Error(message), { status })
  return Object.assign(new Error(`Discord API error: ${status} ${message}`), {
    originalError: original,
  })
}

it.effect('keeps the guild owner visible despite an explicit member deny', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelRaw: channelWithOverwrites([overwrite('U1', 1, '0', '1024')]),
      guildOwnerId: 'U1',
      guildRoles: [guildRole('guild-1', '0')],
      guildMembers: [guildMember('U1', 'owner', []), guildMember('U2', 'bob', [])],
    })
    const result = yield* listDiscordMembers(adapter, { binding, target: channelTarget, limit: 20 })

    assert.deepStrictEqual(
      result.members.map((member) => member.platformUserId),
      ['U1'],
    )
    assert.isTrue(
      canDiscordMemberViewChannel({
        guildId: 'guild-1',
        memberId: 'U1',
        memberRoleIds: [],
        rolesById: new Map([['guild-1', 0n]]),
        overwrites: [{ id: 'U1', type: 1, allow: '0', deny: '1024' }],
        ownerId: 'U1',
      }),
    )
  }),
)

it.effect('maps structured 401/403 to unavailable scope on guild, roles, and members', () =>
  Effect.gen(function* () {
    const guildDenied = yield* listDiscordMembers(
      stubAdapter({
        channelRaw: channelWithOverwrites([]),
        guildError: structuredRestError(401, 'Unauthorized'),
        guildRoles: [guildRole('guild-1', '1024')],
      }),
      { binding, target: channelTarget, limit: 20 },
    ).pipe(Effect.flip)
    assert(isMembersUnsupported(guildDenied))

    const rolesDenied = yield* listDiscordMembers(
      stubAdapter({
        channelRaw: channelWithOverwrites([]),
        guildRolesError: structuredRestError(403, 'Missing Access'),
      }),
      { binding, target: channelTarget, limit: 20 },
    ).pipe(Effect.flip)
    assert(isMembersUnsupported(rolesDenied))

    const membersDenied = yield* listDiscordMembers(
      stubAdapter({
        channelRaw: channelWithOverwrites([]),
        guildRoles: [guildRole('guild-1', '1024')],
        guildMembersError: structuredRestError(403, 'Missing Access'),
      }),
      { binding, target: channelTarget, limit: 20 },
    ).pipe(Effect.flip)
    assert(isMembersUnsupported(membersDenied))
  }),
)

it.effect('maps 404 to not-found and 5xx to a typed members error', () =>
  Effect.gen(function* () {
    const channelMissing = yield* listDiscordMembers(
      stubAdapter({
        channelError: structuredRestError(404, 'Unknown Channel'),
        guildRoles: [guildRole('guild-1', '1024')],
      }),
      { binding, target: channelTarget, limit: 20 },
    ).pipe(Effect.flip)
    assert(isTargetNotFound(channelMissing))

    const membersMissing = yield* listDiscordMembers(
      stubAdapter({
        channelRaw: channelWithOverwrites([]),
        guildRoles: [guildRole('guild-1', '1024')],
        guildMembersError: structuredRestError(404, 'Unknown Guild'),
      }),
      { binding, target: channelTarget, limit: 20 },
    ).pipe(Effect.flip)
    assert(isTargetNotFound(membersMissing))

    const rolesFailed = yield* listDiscordMembers(
      stubAdapter({
        channelRaw: channelWithOverwrites([]),
        guildRolesError: structuredRestError(500, 'Internal Error'),
      }),
      { binding, target: channelTarget, limit: 20 },
    ).pipe(Effect.flip)
    assert(isPublicationError(rolesFailed))
    assert.strictEqual(rolesFailed.operation, 'list-members')

    const membersFailed = yield* listDiscordMembers(
      stubAdapter({
        channelRaw: channelWithOverwrites([]),
        guildRoles: [guildRole('guild-1', '1024')],
        guildMembersError: structuredRestError(503, 'Unavailable'),
      }),
      { binding, target: channelTarget, limit: 20 },
    ).pipe(Effect.flip)
    assert(isPublicationError(membersFailed))
    assert.strictEqual(membersFailed.operation, 'list-members')
  }),
)

it.effect('fails a full malformed page instead of returning a cursorless truncated page', () =>
  Effect.gen(function* () {
    const error = yield* listDiscordMembers(
      stubAdapter({
        channelRaw: channelWithOverwrites([]),
        guildRoles: [guildRole('guild-1', '1024')],
        guildMembersRaw: [{ nope: true }, { user: null }, { user: { id: '   ' } }],
      }),
      { binding, target: channelTarget, limit: 20 },
    ).pipe(Effect.flip)

    assert(isPublicationError(error))
    assert.strictEqual(error.operation, 'list-members')
  }),
)

it.effect('skips malformed rows but advances past valid ids before valid rows', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter({
      channelRaw: channelWithOverwrites([]),
      guildRoles: [guildRole('guild-1', '1024')],
      guildMembersRaw: [
        { nope: true },
        { user: { id: 'U0' } },
        guildMember('U1', 'alice', []),
        guildMember('U2', 'bob', []),
      ],
    })
    const result = yield* listDiscordMembers(adapter, { binding, target: channelTarget, limit: 20 })

    assert.deepStrictEqual(
      result.members.map((member) => member.platformUserId),
      ['U1', 'U2'],
    )
    assert.isFalse(result.truncated)
    assert.isUndefined(result.nextCursor)
  }),
)

it.effect('ends the final page without a cursor and keeps truncated cursors defined', () =>
  Effect.gen(function* () {
    const single = stubAdapter({
      channelRaw: channelWithOverwrites([]),
      guildRoles: [guildRole('guild-1', '1024')],
      guildMembers: [guildMember('U1', 'alice', [])],
    })
    const final = yield* listDiscordMembers(single, { binding, target: channelTarget, limit: 20 })
    assert.isFalse(final.truncated)
    assert.isUndefined(final.nextCursor)

    const paged = stubAdapter({
      channelRaw: channelWithOverwrites([]),
      guildRoles: [guildRole('guild-1', '1024')],
      guildMembers: [guildMember('U1', 'alice', []), guildMember('U2', 'bob', [])],
    })
    const first = yield* listDiscordMembers(paged, { binding, target: channelTarget, limit: 1 })
    assert.isTrue(first.truncated)
    assert.strictEqual(first.nextCursor, 'U1')
  }),
)

const manyGuilds = (count: number): ReadonlyArray<{ readonly id: string; readonly name: string }> =>
  Array.from({ length: count }, (_, index) => ({
    id: `guild-${String(index).padStart(3, '0')}`,
    name: `Guild ${String(index).padStart(3, '0')}`,
  }))

it.effect('paginates guild scopes across API pages with an opaque cursor', () =>
  Effect.gen(function* () {
    const all = manyGuilds(201)
    const adapter = stubAdapter({ botGuilds: [...all] })
    // Tool limit 50 over a 200-row native page: local skip first, then `after`.
    const first = yield* discoverDiscord(adapter, { binding, action: 'scopes', limit: 50 })
    assert.strictEqual(first.action, 'scopes')
    if (first.action !== 'scopes') return
    assert.strictEqual(first.scopes.length, 50)
    assert.isTrue(first.truncated)
    assert.isDefined(first.nextCursor)
    assert.notStrictEqual(first.nextCursor, '50')
    // Native pagination uses `limit`/`after`, never numeric offsets.
    assert.deepStrictEqual(adapter.botGuildCalls[0], { limit: 200 })

    const second = yield* discoverDiscord(adapter, {
      binding,
      action: 'scopes',
      limit: 50,
      cursor: first.nextCursor,
    })
    assert.strictEqual(second.action, 'scopes')
    if (second.action !== 'scopes') return
    assert.strictEqual(second.scopes.length, 50)
    assert.isTrue(second.truncated)
    assert.isDefined(second.nextCursor)
    assert.notStrictEqual(first.scopes[0]?.id, second.scopes[0]?.id)
    // Second call refetches the same native page with a local skip.
    assert.deepStrictEqual(adapter.botGuildCalls[1], { limit: 200 })

    // Walk to the terminal page: every truncated page carries a cursor,
    // the terminal page carries none.
    let cursor = second.nextCursor
    let total = 50 + 50
    let pages = 2
    for (;;) {
      const result = yield* discoverDiscord(adapter, {
        binding,
        action: 'scopes',
        limit: 50,
        cursor,
      })
      assert.strictEqual(result.action, 'scopes')
      if (result.action !== 'scopes') return
      assert.strictEqual(result.truncated, result.nextCursor !== undefined)
      if (!result.truncated) {
        total += result.scopes.length
        pages += 1
        break
      }
      assert.isDefined(result.nextCursor)
      cursor = result.nextCursor
      total += result.scopes.length
      pages += 1
      if (pages > 10) throw new Error('scopes pagination did not terminate')
    }
    assert.strictEqual(total, 201)
    assert.strictEqual(pages, 5)
    // The final native fetch uses `after` to reach the second API page.
    assert.isTrue(adapter.botGuildCalls.some((call) => call.after !== undefined))
  }),
)

it.effect('keeps guild scope boundaries honest at the native page edge', () =>
  Effect.gen(function* () {
    const all = manyGuilds(200)
    const adapter = stubAdapter({ botGuilds: [...all] })
    const first = yield* discoverDiscord(adapter, { binding, action: 'scopes', limit: 200 })
    assert.strictEqual(first.action, 'scopes')
    if (first.action !== 'scopes') return
    assert.strictEqual(first.scopes.length, 200)
    // A full native page may hide more guilds: honest continuation even at
    // the exact boundary, never a false terminal.
    assert.isTrue(first.truncated)
    assert.isDefined(first.nextCursor)

    const second = yield* discoverDiscord(adapter, {
      binding,
      action: 'scopes',
      limit: 200,
      cursor: first.nextCursor,
    })
    assert.strictEqual(second.action, 'scopes')
    if (second.action !== 'scopes') return
    assert.deepStrictEqual(second.scopes, [])
    assert.isFalse(second.truncated)
    assert.isUndefined(second.nextCursor)
  }),
)

it.effect('rejects numeric offset cursors for guild scopes', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter()
    const error = yield* discoverDiscord(adapter, {
      binding,
      action: 'scopes',
      limit: 1,
      cursor: '1',
    }).pipe(Effect.flip)
    assert(isPublicationError(error))
    assert.deepStrictEqual(adapter.botGuildCalls, [])
  }),
)

it.effect('lists channels across every guild page, not just the first', () =>
  Effect.gen(function* () {
    const all = manyGuilds(201)
    const guildChannels: Record<
      string,
      ReadonlyArray<{ readonly id: string; readonly name?: string; readonly type?: number }>
    > = {}
    for (const guild of all) {
      guildChannels[guild.id] = [
        { id: `channel-${guild.id}`, name: `general-${guild.id}`, type: 0 },
      ]
    }
    const adapter = stubAdapter({ botGuilds: [...all], guildChannels })
    const seen = new Set<string>()
    let cursor: string | undefined
    for (let pages = 0; pages < 10; pages += 1) {
      let channelsQuery: Parameters<typeof discoverDiscord>[1] = {
        binding,
        action: 'channels',
        limit: 50,
      }
      if (cursor !== undefined) channelsQuery = { ...channelsQuery, cursor }
      const result = yield* discoverDiscord(adapter, channelsQuery)
      assert.strictEqual(result.action, 'channels')
      if (result.action !== 'channels') return
      assert.strictEqual(result.truncated, result.nextCursor !== undefined)
      for (const channel of result.channels) {
        if (channel.target.platform !== 'discord') continue
        seen.add(`${channel.target.guildId}:${channel.target.channelId}`)
      }
      if (!result.truncated) break
      cursor = result.nextCursor
    }
    assert.strictEqual(seen.size, 201)
    // The last guild lives on the second native guild page; its channel
    // proves the scan crossed the page boundary.
    assert.isTrue(seen.has('guild-200:channel-guild-200'))
    assert.isTrue(adapter.botGuildCalls.length > 1)
  }),
)

it.effect('paginates filtered channels with an opaque offset cursor', () =>
  Effect.gen(function* () {
    const adapter = stubAdapter()
    const first = yield* discoverDiscord(adapter, { binding, action: 'channels', limit: 1 })
    assert.strictEqual(first.action, 'channels')
    if (first.action !== 'channels') return
    assert.strictEqual(first.channels.length, 1)
    assert.isTrue(first.truncated)
    assert.isDefined(first.nextCursor)
    assert.notStrictEqual(first.nextCursor, '1')

    const second = yield* discoverDiscord(adapter, {
      binding,
      action: 'channels',
      limit: 1,
      cursor: first.nextCursor,
    })
    assert.strictEqual(second.action, 'channels')
    if (second.action !== 'channels') return
    assert.strictEqual(second.channels.length, 1)
    assert.isFalse(second.truncated)
    assert.isUndefined(second.nextCursor)
    assert.notStrictEqual(
      first.channels[0]?.target.platform === 'discord'
        ? first.channels[0]?.target.channelId
        : undefined,
      second.channels[0]?.target.platform === 'discord'
        ? second.channels[0]?.target.channelId
        : undefined,
    )
  }),
)
