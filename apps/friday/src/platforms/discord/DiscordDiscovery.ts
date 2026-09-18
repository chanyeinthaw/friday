import type { DiscordAdapter } from '@chat-adapter/discord'
import type { ListThreadsOptions, ThreadSummary } from 'chat'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import {
  isDiscordThreadTarget,
  PlatformMembersUnsupportedError,
  PlatformTargetNotFoundError,
  type DiscordQueryTarget,
  type PlatformDiscoveryChannel,
  type PlatformDiscoveryQuery,
  type PlatformDiscoveryResult,
  type PlatformDiscoveryScope,
  type PlatformDiscoveryThread,
  type PlatformMember,
  type PlatformMembersQuery,
  type PlatformMembersResult,
} from '../PlatformAdapter.ts'
import { decodeDiscoveryOffset, matchesDiscoveryQuery } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'
import { isDiscordThread } from './DiscordConversationScope.ts'

/**
 * Pagination options for the native Discord thread-members endpoint.
 * Fields stay mutable so callers can attach them in separate statements.
 */
export interface DiscordThreadMembersOptions {
  limit?: number
  after?: string
}

/** Transport needed for Discord member listing and discovery. */
export interface DiscordDiscoveryAdapter extends Pick<
  DiscordAdapter,
  'decodeThreadId' | 'encodeThreadId' | 'fetchChannelInfo' | 'listThreads'
> {
  readonly fetchThreadMembers: (
    threadId: string,
    options?: DiscordThreadMembersOptions,
  ) => Promise<ReadonlyArray<unknown>>
}

/** Guild snapshot for discovery scopes/channels; never carries tokens or user allowlists. */
export interface DiscordDiscoveryGuildSnapshot {
  readonly guildId: string
  readonly enabled: boolean
  /** Configured per-channel override IDs; admission still decides per channel. */
  readonly channelIds: ReadonlyArray<string>
}

export interface DiscordDiscoveryPolicy {
  readonly resolveChannelPolicy: (
    guildId: string,
    channelId: string,
  ) => DiscordResolvedChannelPolicy | undefined
  readonly listGuilds: () => ReadonlyArray<DiscordDiscoveryGuildSnapshot>
}

const targetNotFound = () => new PlatformTargetNotFoundError({ kind: 'discord' })
const discoverError = (cause: unknown) =>
  new ChatSdkPublicationError({ operation: 'discover', cause })
const membersError = (cause: unknown) =>
  new ChatSdkPublicationError({ operation: 'list-members', cause })
const channelMembersUnsupported = () =>
  new PlatformMembersUnsupportedError({
    kind: 'discord',
    detail:
      'Discord channel member listing is not supported: guild member enumeration is privileged and unbounded. Use a thread target to list thread members.',
  })

const DiscordThreadChannel = Schema.Struct({
  id: Schema.String,
  parent_id: Schema.String,
  type: Schema.Literals([10, 11, 12]),
})
const decodeDiscordThreadChannel = Schema.decodeUnknownOption(DiscordThreadChannel)

const DiscordThreadMemberRaw = Schema.Struct({
  user_id: Schema.optionalKey(Schema.String),
  member: Schema.optionalKey(
    Schema.Struct({
      user: Schema.optionalKey(
        Schema.Struct({
          id: Schema.String,
          username: Schema.optionalKey(Schema.String),
          global_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
          bot: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      nick: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})
type DiscordThreadMemberRow = typeof DiscordThreadMemberRaw.Type
const decodeDiscordThreadMember = Schema.decodeUnknownOption(DiscordThreadMemberRaw)

const memberFrom = (row: DiscordThreadMemberRow): PlatformMember | undefined => {
  const userId = row.user_id ?? row.member?.user?.id
  if (userId === undefined || userId.trim() === '') return undefined
  const username = row.member?.user?.username ?? userId
  const displayName = row.member?.nick ?? row.member?.user?.global_name ?? username
  return {
    platformUserId: userId,
    username,
    displayName: displayName ?? userId,
    mention: `<@${userId}>`,
    isBot: row.member?.user?.bot ?? 'unknown',
  }
}

interface DiscordResolvedTarget {
  readonly guildId: string
  /** Effective channel for policy gating: the parent channel for threads. */
  readonly channelId: string
  readonly source: string
  readonly threadId: string | undefined
}

/**
 * Resolves an explicit Discord target against the live admission policy.
 * Mirrors the query/post gate: threads inherit their parent-channel policy
 * and a supplied parent hint must agree; `@me` direct messages are never
 * valid targets. Fail-closed to a generic not-found.
 */
const resolveDiscordTarget = Effect.fn('DiscordDiscovery.resolveTarget')(function* (
  discord: DiscordDiscoveryAdapter,
  target: DiscordQueryTarget,
  policy: DiscordDiscoveryPolicy,
) {
  if (target.guildId === '@me') return yield* targetNotFound()
  if (isDiscordThreadTarget(target)) {
    // Extracted before async boundaries: property narrowing does not cross closures.
    const threadId = target.threadId
    const parentHint = target.channelId
    const info = yield* Effect.tryPromise({
      try: () =>
        discord.fetchChannelInfo(
          discord.encodeThreadId({ guildId: target.guildId, channelId: threadId }),
        ),
      catch: () => targetNotFound(),
    })
    const thread = Option.getOrUndefined(decodeDiscordThreadChannel(info.metadata.raw))
    if (thread === undefined) return yield* targetNotFound()
    if (parentHint !== undefined && parentHint !== thread.parent_id) {
      return yield* targetNotFound()
    }
    if (policy.resolveChannelPolicy(target.guildId, thread.parent_id) === undefined) {
      return yield* targetNotFound()
    }
    const parentId = thread.parent_id
    const source = yield* Effect.try({
      try: () =>
        discord.encodeThreadId({
          guildId: target.guildId,
          channelId: parentId,
          threadId,
        }),
      catch: () => targetNotFound(),
    })
    return {
      guildId: target.guildId,
      channelId: parentId,
      source,
      threadId,
    } satisfies DiscordResolvedTarget
  }
  if (target.channelId === undefined) return yield* targetNotFound()
  // Extracted before async boundaries: property narrowing does not cross closures.
  const channelId = target.channelId
  if (policy.resolveChannelPolicy(target.guildId, channelId) === undefined) {
    return yield* targetNotFound()
  }
  const source = yield* Effect.try({
    try: () => discord.encodeThreadId({ guildId: target.guildId, channelId }),
    catch: () => targetNotFound(),
  })
  return {
    guildId: target.guildId,
    channelId,
    source,
    threadId: undefined,
  } satisfies DiscordResolvedTarget
})

const MaximumMemberPages = 10

/**
 * Lists members of an explicit Discord thread target through the native
 * thread-members endpoint. Channel targets return a typed
 * unsupported-scope error: guild member enumeration is privileged and
 * unbounded, so Friday never attempts it. Admission matches query/post.
 */
export const listDiscordMembers = Effect.fn('DiscordDiscovery.listMembers')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformMembersQuery,
  policy: DiscordDiscoveryPolicy,
) {
  if (query.target.platform !== 'discord') return yield* targetNotFound()
  if (!isDiscordThreadTarget(query.target)) return yield* channelMembersUnsupported()
  const resolved = yield* resolveDiscordTarget(discord, query.target, policy)
  const seen = new Set<string>()
  const members: Array<PlatformMember> = []
  let after: string | undefined
  let pages = 0
  while (members.length < query.limit && pages < MaximumMemberPages) {
    pages += 1
    const memberOptions: DiscordThreadMembersOptions = {
      limit: Math.min(query.limit - members.length, 50),
    }
    if (after !== undefined) memberOptions.after = after
    const rows = yield* Effect.tryPromise({
      try: () => discord.fetchThreadMembers(resolved.source, memberOptions),
      catch: (cause) => membersError(cause),
    })
    if (rows.length === 0) break
    let progressed = false
    for (const row of rows) {
      const decoded = Option.getOrUndefined(decodeDiscordThreadMember(row))
      const member = decoded === undefined ? undefined : memberFrom(decoded)
      if (member === undefined || seen.has(member.platformUserId)) continue
      seen.add(member.platformUserId)
      members.push(member)
      after = member.platformUserId
      progressed = true
      if (members.length >= query.limit) break
    }
    if (!progressed) break
  }
  return {
    members,
    nextCursor: undefined,
    truncated: false,
  } satisfies PlatformMembersResult
})

interface DiscordCurrentLocation {
  readonly guildId: string
  readonly channelId: string
  readonly threadId: string | undefined
}

const decodeCurrentLocation = (
  discord: DiscordDiscoveryAdapter,
  conversationId: string,
): Effect.Effect<DiscordCurrentLocation, ChatSdkPublicationError> =>
  Effect.try({
    try: () => {
      const location = discord.decodeThreadId(conversationId)
      return {
        guildId: location.guildId,
        channelId: location.channelId,
        threadId: isDiscordThread(location) ? location.threadId : undefined,
      }
    },
    catch: (cause) => discoverError(cause),
  })

const channelName = (
  discord: DiscordDiscoveryAdapter,
  encodedId: string,
): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({
    try: () => discord.fetchChannelInfo(encodedId).then((info) => info.name),
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => undefined))

interface OffsetPage {
  readonly page: ReadonlyArray<string>
  readonly nextCursor: string | undefined
  readonly truncated: boolean
}

const paginateIds = (
  ids: ReadonlyArray<string>,
  limit: number,
  cursor: string | undefined,
): Effect.Effect<OffsetPage, ChatSdkPublicationError> => {
  const offsetOption = decodeDiscoveryOffset(cursor)
  if (Option.isNone(offsetOption)) {
    return Effect.fail(discoverError('invalid-cursor'))
  }
  const start = offsetOption.value
  const next = start + limit
  if (next < ids.length) {
    return Effect.succeed({
      page: ids.slice(start, next),
      nextCursor: String(next),
      truncated: true,
    })
  }
  return Effect.succeed({ page: ids.slice(start, next), nextCursor: undefined, truncated: false })
}

const discoverCurrent = Effect.fn('DiscordDiscovery.current')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
) {
  const location = yield* decodeCurrentLocation(discord, String(query.binding.conversationId))
  const isThread = location.threadId !== undefined
  const target: DiscordQueryTarget = isThread
    ? {
        platform: 'discord',
        guildId: location.guildId,
        channelId: location.channelId,
        threadId: location.threadId,
      }
    : { platform: 'discord', guildId: location.guildId, channelId: location.channelId }
  const encoded = isThread
    ? discord.encodeThreadId({
        guildId: location.guildId,
        channelId: location.channelId,
        threadId: location.threadId,
      })
    : discord.encodeThreadId({ guildId: location.guildId, channelId: location.channelId })
  const name = yield* channelName(discord, encoded)
  return {
    action: 'current' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    current: {
      target,
      targetType: isThread ? ('thread' as const) : ('channel' as const),
      name,
      isDirectMessage: location.guildId === '@me',
    },
  } satisfies PlatformDiscoveryResult
})

const discoverScopes = Effect.fn('DiscordDiscovery.scopes')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
  policy: DiscordDiscoveryPolicy,
) {
  const location = yield* decodeCurrentLocation(discord, String(query.binding.conversationId))
  const currentGuildId = location.guildId
  const scopes: Array<PlatformDiscoveryScope> = []
  for (const guild of policy.listGuilds()) {
    if (!guild.enabled) continue
    if (!matchesDiscoveryQuery([guild.guildId], query.query)) continue
    scopes.push({
      kind: 'guild',
      id: guild.guildId,
      isCurrent: guild.guildId === currentGuildId,
    })
  }
  const page = yield* paginateIds(
    scopes.map((scope) => scope.id),
    query.limit,
    query.cursor,
  )
  return {
    action: 'scopes' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    scopes: scopes.filter((scope) => page.page.includes(scope.id)),
    nextCursor: page.nextCursor,
    truncated: page.truncated,
  } satisfies PlatformDiscoveryResult
})

const discoverChannels = Effect.fn('DiscordDiscovery.channels')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
  policy: DiscordDiscoveryPolicy,
) {
  const location = yield* decodeCurrentLocation(discord, String(query.binding.conversationId))
  const guilds = policy
    .listGuilds()
    .filter(
      (guild) => guild.enabled && (query.guildId === undefined || guild.guildId === query.guildId),
    )
  const candidates: Array<{ readonly guildId: string; readonly channelId: string }> = []
  const seen = new Set<string>()
  for (const guild of guilds) {
    const ids =
      guild.guildId === location.guildId && !guild.channelIds.includes(location.channelId)
        ? [...guild.channelIds, location.channelId]
        : guild.channelIds
    for (const channelId of ids) {
      const key = `${guild.guildId}:${channelId}`
      if (seen.has(key)) continue
      seen.add(key)
      // Per-channel admission: overrides never grant, scopes decide.
      if (policy.resolveChannelPolicy(guild.guildId, channelId) === undefined) continue
      candidates.push({ guildId: guild.guildId, channelId })
    }
  }
  // Candidates are policy-known IDs only (configured overrides plus the current
  // channel), so enriching every name stays bounded without platform enumeration.
  const enriched: Array<{
    readonly guildId: string
    readonly channelId: string
    readonly name: string | undefined
  }> = []
  for (const candidate of candidates) {
    const name = yield* channelName(
      discord,
      discord.encodeThreadId({ guildId: candidate.guildId, channelId: candidate.channelId }),
    )
    if (!matchesDiscoveryQuery([candidate.channelId, candidate.guildId, name], query.query)) {
      continue
    }
    enriched.push({ guildId: candidate.guildId, channelId: candidate.channelId, name })
  }
  const page = yield* paginateIds(
    enriched.map((entry) => `${entry.guildId}:${entry.channelId}`),
    query.limit,
    query.cursor,
  )
  const channels: Array<PlatformDiscoveryChannel> = []
  for (const key of page.page) {
    const entry = enriched.find((item) => `${item.guildId}:${item.channelId}` === key)
    if (entry === undefined) continue
    channels.push({
      target: {
        platform: 'discord',
        guildId: entry.guildId,
        channelId: entry.channelId,
      },
      name: entry.name,
      isCurrent: entry.guildId === location.guildId && entry.channelId === location.channelId,
      isDirectMessage: false,
    })
  }
  return {
    action: 'channels' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    channels,
    nextCursor: page.nextCursor,
    truncated: page.truncated,
  } satisfies PlatformDiscoveryResult
})

const threadEntryFrom = (
  thread: ThreadSummary<unknown>,
  guildId: string,
  channelId: string,
  currentThreadId: string | undefined,
): PlatformDiscoveryThread | undefined => {
  const text = thread.rootMessage.text.trim()
  const segments = thread.id.split(':')
  const threadId = segments[3] ?? segments[2]
  if (threadId === undefined || threadId === '') return undefined
  const name = text === '' ? undefined : text.slice(0, 80)
  return {
    target: { platform: 'discord', guildId, channelId, threadId },
    name,
    rootSnippet: text === '' ? undefined : text.slice(0, 160),
    replyCount: thread.replyCount,
    isCurrent: threadId === currentThreadId,
  }
}

const discoverThreads = Effect.fn('DiscordDiscovery.threads')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
  policy: DiscordDiscoveryPolicy,
) {
  const parent = query.channelTarget
  if (parent === undefined || parent.platform !== 'discord' || isDiscordThreadTarget(parent)) {
    return yield* new PlatformMembersUnsupportedError({
      kind: 'discord',
      detail: 'Thread discovery requires an explicit Discord channel target.',
    })
  }
  if (parent.channelId === undefined) return yield* targetNotFound()
  if (parent.guildId === '@me') return yield* targetNotFound()
  // Extracted before async boundaries: property narrowing does not cross closures.
  const parentGuildId = parent.guildId
  const parentChannelId = parent.channelId
  if (policy.resolveChannelPolicy(parentGuildId, parentChannelId) === undefined) {
    return yield* targetNotFound()
  }
  const location = yield* decodeCurrentLocation(discord, String(query.binding.conversationId))
  const threadOptions: ListThreadsOptions = {
    limit: Math.min(query.limit, 50),
  }
  if (query.cursor !== undefined) threadOptions.cursor = query.cursor
  const listed = yield* Effect.tryPromise({
    try: () =>
      discord.listThreads(
        discord.encodeThreadId({ guildId: parentGuildId, channelId: parentChannelId }),
        threadOptions,
      ),
    catch: (cause) => discoverError(cause),
  })
  const threads: Array<PlatformDiscoveryThread> = []
  for (const thread of listed.threads) {
    if (threads.length >= query.limit) break
    const entry = threadEntryFrom(thread, parentGuildId, parentChannelId, location.threadId)
    if (entry === undefined) continue
    if (!matchesDiscoveryQuery([entry.name, entry.rootSnippet], query.query)) continue
    threads.push(entry)
  }
  return {
    action: 'threads' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    threads,
    nextCursor: listed.nextCursor,
    truncated: listed.nextCursor !== undefined,
  } satisfies PlatformDiscoveryResult
})

/**
 * Read-only Discord discovery through the current connection only. Scopes and
 * channels enumerate the live policy snapshot (enabled guilds, admitted
 * channels); names resolve best-effort and never fail the listing. Threads
 * use the native thread list on an admitted parent channel. Unadmitted
 * parents collapse to not-found without revealing existence.
 */
export const discoverDiscord = Effect.fn('DiscordDiscovery.discover')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
  policy: DiscordDiscoveryPolicy,
) {
  switch (query.action) {
    case 'current':
      return yield* discoverCurrent(discord, query)
    case 'scopes':
      return yield* discoverScopes(discord, query, policy)
    case 'channels':
      return yield* discoverChannels(discord, query, policy)
    case 'threads':
      return yield* discoverThreads(discord, query, policy)
  }
})
