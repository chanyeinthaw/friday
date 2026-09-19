import type { DiscordAdapter } from '@chat-adapter/discord'
import type { ListThreadsOptions, ThreadSummary } from 'chat'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
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
import { matchesDiscoveryQuery } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import { isDiscordThread } from './DiscordConversationScope.ts'

/**
 * Pagination options for the native Discord thread-members endpoint.
 * Fields stay mutable so callers can attach them in separate statements.
 */
export interface DiscordThreadMembersOptions {
  limit?: number
  after?: string
}

/**
 * Pagination options for the native Discord guild-members endpoint.
 * Fields stay mutable so callers can attach them in separate statements.
 */
export interface DiscordGuildMembersOptions {
  limit?: number
  after?: string
}

/**
 * Pagination options for `GET /users/@me/guilds` per the Discord API:
 * `limit` (1-200), `after` (guild id), and `before` (guild id).
 * Fields stay mutable so callers can attach them in separate statements.
 */
export interface DiscordBotGuildsOptions {
  limit?: number
  after?: string
  before?: string
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
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Discord guild payloads are Schema-decoded at the discovery boundary.
  readonly fetchGuild: (guildId: string) => Promise<unknown>
  readonly fetchGuildRoles: (guildId: string) => Promise<ReadonlyArray<unknown>>
  readonly fetchGuildMembers: (
    guildId: string,
    options?: DiscordGuildMembersOptions,
  ) => Promise<ReadonlyArray<unknown>>
  /**
   * Bot-visible guilds via `GET /users/@me/guilds` with native `limit` /
   * `after` / `before` pagination; the visible-scope source for guild
   * discovery.
   */
  readonly fetchBotGuilds: (options?: DiscordBotGuildsOptions) => Promise<ReadonlyArray<unknown>>
  /** Bot-visible channels of one guild via `GET /guilds/{guild}/channels`. */
  readonly fetchGuildChannels: (guildId: string) => Promise<ReadonlyArray<unknown>>
}

const targetNotFound = () => new PlatformTargetNotFoundError({ kind: 'discord' })
const discoverError = (cause: unknown) =>
  new ChatSdkPublicationError({ operation: 'discover', cause })
const membersError = (cause: unknown) =>
  new ChatSdkPublicationError({ operation: 'list-members', cause })
const channelMembersUnavailable = () =>
  new PlatformMembersUnsupportedError({
    kind: 'discord',
    detail:
      'Discord channel member listing is unavailable: the bot needs the privileged Server Members (GuildMembers) intent and permission to list guild members and view the channel. Enable the intent and grant access, then retry.',
  })

const DiscordRestFailure = Schema.Struct({
  status: Schema.optionalKey(Schema.Finite),
  message: Schema.optionalKey(Schema.String),
  originalError: Schema.optionalKey(Schema.Struct({ status: Schema.optionalKey(Schema.Finite) })),
})
const decodeDiscordRestFailure = Schema.decodeUnknownOption(DiscordRestFailure)

/**
 * Extracts an HTTP status from Discord REST failures.
 * Primary is the structured `NetworkError.originalError.status`
 * (a `DiscordApiError.status`); repository-compatible `status` fields and
 * `Discord API error: <status>` message text are fallback only.
 */
const discordHttpStatus = (cause: unknown): number | undefined => {
  const decoded = Option.getOrUndefined(decodeDiscordRestFailure(cause))
  if (decoded?.originalError?.status !== undefined) return decoded.originalError.status
  if (decoded?.status !== undefined) return decoded.status
  const message = decoded?.message
  if (message === undefined) return undefined
  const match = /Discord API error:\s*(\d{3})/.exec(message)
  if (match?.[1] !== undefined) {
    const status = Number(match[1])
    return Number.isInteger(status) ? status : undefined
  }
  if (
    message.includes('Missing Access') ||
    message.includes('Missing Intent') ||
    message.includes('privileged')
  ) {
    return 403
  }
  return undefined
}

/**
 * Central REST classification for channel, guild, roles, and members reads.
 * 401/403 (missing token, Server Members intent, or API permissions) maps to
 * an unavailable-scope error; 404 maps to not-found; 5xx, network failures,
 * and rate limits map to a typed `list-members` operation error.
 */
const mapChannelMembersRestError = (
  cause: unknown,
): PlatformMembersUnsupportedError | PlatformTargetNotFoundError | ChatSdkPublicationError => {
  const status = discordHttpStatus(cause)
  if (status === 401 || status === 403) return channelMembersUnavailable()
  if (status === 404) return targetNotFound()
  return membersError(cause)
}

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
  /** Effective channel for access checks: the parent channel for threads. */
  readonly channelId: string
  readonly source: string
  readonly threadId: string | undefined
}

const DiscordChannelGuildRaw = Schema.Struct({
  guild_id: Schema.optionalKey(Schema.String),
})
const decodeDiscordChannelGuild = Schema.decodeUnknownOption(DiscordChannelGuildRaw)

/**
 * Resolves an explicit Discord target against bot-visible platform state.
 * Threads inherit their parent channel: the parent resolves through channel
 * info, and a supplied parent hint must agree with it; `@me` direct messages
 * are never valid targets. Visibility is established by successful channel
 * reads; failures and malformed payloads collapse fail-closed to a generic
 * not-found that never exposes channel existence. Friday admission config
 * never gates tool targets: the invoking thread is already admitted and only
 * the current connection bounds access.
 */
const resolveDiscordTarget = Effect.fn('DiscordDiscovery.resolveTarget')(function* (
  discord: DiscordDiscoveryAdapter,
  target: DiscordQueryTarget,
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
      catch: (cause) => mapChannelMembersRestError(cause),
    })
    const thread = Option.getOrUndefined(decodeDiscordThreadChannel(info.metadata.raw))
    if (thread === undefined) return yield* targetNotFound()
    if (parentHint !== undefined && parentHint !== thread.parent_id) {
      return yield* targetNotFound()
    }
    const guildId = Option.getOrUndefined(decodeDiscordChannelGuild(info.metadata.raw))?.guild_id
    if (guildId !== undefined && guildId !== target.guildId) {
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
  const channelInfo = yield* Effect.tryPromise({
    try: () =>
      discord.fetchChannelInfo(discord.encodeThreadId({ guildId: target.guildId, channelId })),
    catch: (cause) => mapChannelMembersRestError(cause),
  })
  const channelGuildId = Option.getOrUndefined(
    decodeDiscordChannelGuild(channelInfo.metadata.raw),
  )?.guild_id
  if (channelGuildId !== undefined && channelGuildId !== target.guildId) {
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
const MaximumChannelMemberPages = 5
const GuildMembersPageSize = 1000

/**
 * Discord permission bits mirrored from discord-api-types PermissionFlagsBits.
 * Guild owner and Administrator bypass channel overwrites; ViewChannel gates
 * channel visibility. No official chat-adapter helper computes effective
 * channel permissions from REST snapshots, so the documented overwrite
 * algorithm below applies them. Only the channel payload's own
 * `permission_overwrites` apply here; category inheritance is out of scope.
 */
const DiscordAdministratorBit = 8n
const DiscordViewChannelBit = 1024n

/** Parses Discord stringified permission bitfields without throwing. */
const parsePermissionBits = (value: string | number | undefined): bigint => {
  if (value === undefined) return 0n
  const text = String(value).trim()
  if (text === '' || /^-?\d+$/.test(text) !== true) return 0n
  return BigInt(text)
}

const DiscordPermissionBitsField = Schema.Union([Schema.String, Schema.Number])

const DiscordGuildRoleRaw = Schema.Struct({
  id: Schema.String,
  permissions: DiscordPermissionBitsField,
})
const decodeDiscordGuildRole = Schema.decodeUnknownOption(DiscordGuildRoleRaw)

const DiscordChannelOverwriteRaw = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals([0, 1]),
  allow: DiscordPermissionBitsField,
  deny: DiscordPermissionBitsField,
})
type DiscordChannelOverwriteRow = typeof DiscordChannelOverwriteRaw.Type
const decodeDiscordChannelOverwrite = Schema.decodeUnknownOption(DiscordChannelOverwriteRaw)

const DiscordChannelOverwritesRaw = Schema.Struct({
  type: Schema.Number,
  permission_overwrites: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})
const decodeDiscordChannelOverwrites = Schema.decodeUnknownOption(DiscordChannelOverwritesRaw)

const DiscordGuildRaw = Schema.Struct({
  id: Schema.String,
  owner_id: Schema.String,
})
const decodeDiscordGuild = Schema.decodeUnknownOption(DiscordGuildRaw)

const DiscordGuildMemberRaw = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    username: Schema.optionalKey(Schema.String),
    global_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
    bot: Schema.optionalKey(Schema.Boolean),
  }),
  nick: Schema.optionalKey(Schema.NullOr(Schema.String)),
  roles: Schema.Array(Schema.String),
})
type DiscordGuildMemberRow = typeof DiscordGuildMemberRaw.Type
const decodeDiscordGuildMember = Schema.decodeUnknownOption(DiscordGuildMemberRaw)

/** Effective ViewChannel input for one guild member in one channel. */
export interface DiscordViewChannelInput {
  readonly guildId: string
  readonly memberId: string
  readonly memberRoleIds: ReadonlyArray<string>
  readonly rolesById: ReadonlyMap<string, bigint>
  readonly overwrites: ReadonlyArray<DiscordChannelOverwriteRow>
  /** Trustworthy guild `owner_id` from REST; always visible when it matches. */
  readonly ownerId?: string | undefined
}

/**
 * Discord's documented channel permission algorithm, applied typesafely.
 * The guild owner is always visible before any role/overwrite evaluation,
 * including an explicit member deny. Base is @everyone plus member roles;
 * Administrator bypasses overwrites; then @everyone, combined role, and
 * member overwrites apply in order before the ViewChannel check. Unknown
 * roles and malformed bits deny rather than grant.
 */
export const canDiscordMemberViewChannel = (input: DiscordViewChannelInput): boolean => {
  if (input.ownerId !== undefined && input.memberId === input.ownerId) return true
  let permissions = input.rolesById.get(input.guildId) ?? 0n
  for (const roleId of input.memberRoleIds) {
    if (roleId === input.guildId) continue
    permissions |= input.rolesById.get(roleId) ?? 0n
  }
  if ((permissions & DiscordAdministratorBit) !== 0n) return true
  const overwriteById = new Map<string, DiscordChannelOverwriteRow>()
  for (const overwrite of input.overwrites) {
    if (overwriteById.has(`${overwrite.type}:${overwrite.id}`) !== true) {
      overwriteById.set(`${overwrite.type}:${overwrite.id}`, overwrite)
    }
  }
  const everyone = overwriteById.get(`0:${input.guildId}`)
  if (everyone !== undefined) {
    permissions =
      (permissions & ~parsePermissionBits(everyone.deny)) | parsePermissionBits(everyone.allow)
  }
  let roleDeny = 0n
  let roleAllow = 0n
  for (const roleId of input.memberRoleIds) {
    if (roleId === input.guildId) continue
    const overwrite = overwriteById.get(`0:${roleId}`)
    if (overwrite === undefined) continue
    roleDeny |= parsePermissionBits(overwrite.deny)
    roleAllow |= parsePermissionBits(overwrite.allow)
  }
  permissions = (permissions & ~roleDeny) | roleAllow
  const member = overwriteById.get(`1:${input.memberId}`)
  if (member !== undefined) {
    permissions =
      (permissions & ~parsePermissionBits(member.deny)) | parsePermissionBits(member.allow)
  }
  return (permissions & DiscordViewChannelBit) !== 0n
}

const guildMemberToPlatformMember = (row: DiscordGuildMemberRow): PlatformMember | undefined => {
  const userId = row.user.id.trim()
  if (userId === '') return undefined
  const username = row.user.username ?? userId
  const displayName = row.nick ?? row.user.global_name ?? username
  return {
    platformUserId: userId,
    username,
    displayName: displayName ?? userId,
    mention: `<@${userId}>`,
    isBot: row.user.bot ?? 'unknown',
  }
}

/** Decodes an opaque channel-members cursor to a guild-members `after` id. */
const decodeChannelMembersAfter = (cursor: string | undefined): string | undefined => {
  if (cursor === undefined) return undefined
  const trimmed = cursor.trim()
  return trimmed === '' ? undefined : trimmed
}

const fetchChannelOverwrites = Effect.fn('DiscordDiscovery.channelOverwrites')(function* (
  discord: DiscordDiscoveryAdapter,
  source: string,
) {
  const channelInfo = yield* Effect.tryPromise({
    try: () => discord.fetchChannelInfo(source),
    catch: (cause) => mapChannelMembersRestError(cause),
  })
  const channel = Option.getOrUndefined(decodeDiscordChannelOverwrites(channelInfo.metadata.raw))
  if (channel === undefined) return yield* targetNotFound()
  if (channel.type === 10 || channel.type === 11 || channel.type === 12) {
    return yield* targetNotFound()
  }
  const overwrites: Array<DiscordChannelOverwriteRow> = []
  for (const raw of channel.permission_overwrites ?? []) {
    const decoded = Option.getOrUndefined(decodeDiscordChannelOverwrite(raw))
    if (decoded !== undefined) overwrites.push(decoded)
  }
  return overwrites
})

const fetchGuildOwnerId = Effect.fn('DiscordDiscovery.guildOwner')(function* (
  discord: DiscordDiscoveryAdapter,
  guildId: string,
) {
  const raw = yield* Effect.tryPromise({
    try: () => discord.fetchGuild(guildId),
    catch: (cause) => mapChannelMembersRestError(cause),
  })
  return Option.getOrUndefined(decodeDiscordGuild(raw))?.owner_id
})

const fetchRolesById = Effect.fn('DiscordDiscovery.rolesById')(function* (
  discord: DiscordDiscoveryAdapter,
  guildId: string,
) {
  const rawRoles = yield* Effect.tryPromise({
    try: () => discord.fetchGuildRoles(guildId),
    catch: (cause) => mapChannelMembersRestError(cause),
  })
  const rolesById = new Map<string, bigint>()
  for (const raw of rawRoles) {
    const decoded = Option.getOrUndefined(decodeDiscordGuildRole(raw))
    if (decoded === undefined) continue
    rolesById.set(decoded.id, parsePermissionBits(decoded.permissions))
  }
  return rolesById
})

interface ChannelScanState {
  readonly members: Array<PlatformMember>
  readonly seen: Set<string>
  after: string | undefined
  lastScanned: string | undefined
}

/**
 * Extracts a usable guild-members cursor without full member decoding.
 * Any non-empty trimmed `user.id` advances pagination (real Discord ids are
 * numeric snowflakes); missing or blank ids never advance and never grant
 * access. Full decoding still gates visibility separately.
 */
const DiscordGuildMemberCursorRaw = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
})
const decodeDiscordGuildMemberCursor = Schema.decodeUnknownOption(DiscordGuildMemberCursorRaw)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Guild member rows are untrusted REST payloads decoded at this boundary.
const extractGuildMemberCursorId = (row: unknown): string | undefined => {
  const trimmed = Option.getOrUndefined(decodeDiscordGuildMemberCursor(row))?.user.id.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

interface GuildPageScan {
  /** Raw rows visited, including malformed rows skipped for access. */
  readonly examined: number
  /** True when at least one row carried a usable cursor id. */
  readonly advanced: boolean
}

const scanGuildPage = (
  rows: ReadonlyArray<unknown>,
  state: ChannelScanState,
  guildId: string,
  ownerId: string | undefined,
  rolesById: ReadonlyMap<string, bigint>,
  overwrites: ReadonlyArray<DiscordChannelOverwriteRow>,
  limit: number,
): GuildPageScan => {
  let examined = 0
  let advanced = false
  for (const row of rows) {
    const cursorId = extractGuildMemberCursorId(row)
    if (cursorId !== undefined) {
      state.after = cursorId
      state.lastScanned = cursorId
      advanced = true
    }
    const decoded = Option.getOrUndefined(decodeDiscordGuildMember(row))
    examined += 1
    if (decoded === undefined) continue
    const memberId = decoded.user.id.trim()
    if (memberId === '' || state.seen.has(memberId)) continue
    state.seen.add(memberId)
    const canView = canDiscordMemberViewChannel({
      guildId,
      memberId,
      memberRoleIds: decoded.roles,
      rolesById,
      overwrites,
      ownerId,
    })
    if (canView !== true) continue
    const member = guildMemberToPlatformMember(decoded)
    if (member === undefined) continue
    state.members.push(member)
    if (state.members.length >= limit) break
  }
  return { examined, advanced }
}

/**
 * Lists members of an explicit Discord channel target who can view the channel.
 * Guild metadata, roles, channel overwrites, and guild members page through
 * REST; effective ViewChannel applies the guild owner, @everyone, member
 * roles, administrator, and role/member overwrites in documented order. Only
 * the channel payload's own overwrites apply. Bounded to
 * MaximumChannelMemberPages of GuildMembersPageSize scans per call with an
 * opaque `after` cursor; REST failures map centrally (401/403 unavailable
 * scope, 404 not-found, 5xx/network/rate-limit operation error). A non-empty
 * page without a usable cursor fails as malformed instead of returning a
 * cursorless truncated page or refetching the same page; `truncated: true`
 * always carries `nextCursor`.
 */
const listDiscordChannelMembers = Effect.fn('DiscordDiscovery.listChannelMembers')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformMembersQuery,
  target: DiscordQueryTarget,
) {
  const resolved = yield* resolveDiscordTarget(discord, target)
  const overwrites = yield* fetchChannelOverwrites(discord, resolved.source)
  const ownerId = yield* fetchGuildOwnerId(discord, resolved.guildId)
  const rolesById = yield* fetchRolesById(discord, resolved.guildId)
  const state: ChannelScanState = {
    members: [],
    seen: new Set<string>(),
    after: decodeChannelMembersAfter(query.cursor),
    lastScanned: undefined,
  }
  let exhausted = false
  let pages = 0
  while (
    state.members.length < query.limit &&
    exhausted !== true &&
    pages < MaximumChannelMemberPages
  ) {
    pages += 1
    const pageOptions: DiscordGuildMembersOptions = { limit: GuildMembersPageSize }
    if (state.after !== undefined) pageOptions.after = state.after
    const rows = yield* Effect.tryPromise({
      try: () => discord.fetchGuildMembers(resolved.guildId, pageOptions),
      catch: (cause) => mapChannelMembersRestError(cause),
    })
    if (rows.length === 0) {
      exhausted = true
      break
    }
    const scan = scanGuildPage(
      rows,
      state,
      resolved.guildId,
      ownerId,
      rolesById,
      overwrites,
      query.limit,
    )
    if (!scan.advanced) {
      return yield* membersError('malformed guild members page: no usable cursor')
    }
    if (state.members.length >= query.limit) {
      if (scan.examined < rows.length || rows.length >= GuildMembersPageSize) break
      exhausted = true
    } else if (rows.length < GuildMembersPageSize) exhausted = true
  }
  const truncated = exhausted !== true
  if (truncated && state.lastScanned === undefined) {
    return yield* membersError('malformed guild members page: missing cursor')
  }
  return {
    members: state.members,
    nextCursor: truncated ? state.lastScanned : undefined,
    truncated,
  } satisfies PlatformMembersResult
})

const listDiscordThreadMembers = Effect.fn('DiscordDiscovery.listThreadMembers')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformMembersQuery,
  target: DiscordQueryTarget,
) {
  const resolved = yield* resolveDiscordTarget(discord, target)
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
      catch: (cause) => mapChannelMembersRestError(cause),
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

/**
 * Lists members for an explicit Discord target through the current connection.
 * Thread targets keep the native thread participant listing; ordinary channel
 * targets return guild members who can view the channel via effective
 * ViewChannel permissions. Visibility is established by platform API reads;
 * Friday admission config never gates member inspection.
 */
export const listDiscordMembers = Effect.fn('DiscordDiscovery.listMembers')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformMembersQuery,
) {
  if (query.target.platform !== 'discord') return yield* targetNotFound()
  if (isDiscordThreadTarget(query.target)) {
    return yield* listDiscordThreadMembers(discord, query, query.target)
  }
  return yield* listDiscordChannelMembers(discord, query, query.target)
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

/** Native page size for `GET /users/@me/guilds` (Discord maximum). */
const DiscordGuildsPageSize = 200

/**
 * Opaque scopes cursor: `after` is the Discord `after` guild id for the page
 * to fetch; `skip` is the local offset into that page's query-filtered
 * guilds when a previous call truncated inside one API page.
 */
const DiscordScopesCursorPayload = Schema.Struct({
  v: Schema.Literal(1),
  k: Schema.Literal('discord-scopes'),
  after: Schema.optionalKey(Schema.String),
  skip: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
})
const DiscordScopesCursorJson = Schema.fromJsonString(DiscordScopesCursorPayload)
const decodeDiscordScopesCursorJsonOption = Schema.decodeUnknownOption(DiscordScopesCursorJson)
const encodeDiscordScopesCursorJsonSync = Schema.encodeSync(DiscordScopesCursorJson)

interface DiscordScopesPosition {
  readonly after: string | undefined
  readonly skip: number
}

interface DiscordScopesCursorInput {
  readonly v: 1
  readonly k: 'discord-scopes'
  after?: string
  skip?: number
}

interface DiscordChannelsCursorInput {
  readonly v: 1
  readonly k: 'discord-channels'
  off?: number
}

const decodeDiscordScopesPosition = (
  cursor: string | undefined,
): Option.Option<DiscordScopesPosition> => {
  if (cursor === undefined || cursor.trim() === '') {
    return Option.some({ after: undefined, skip: 0 })
  }
  const jsonResult = Encoding.decodeBase64UrlString(cursor.trim())
  if (!Result.isSuccess(jsonResult)) return Option.none()
  const payload = Option.getOrUndefined(
    decodeDiscordScopesCursorJsonOption(Result.getOrThrow(jsonResult)),
  )
  if (payload === undefined) return Option.none()
  const after = payload.after === undefined || payload.after === '' ? undefined : payload.after
  return Option.some({ after, skip: payload.skip ?? 0 })
}

const encodeDiscordScopesPosition = (position: DiscordScopesPosition): string => {
  const payload: DiscordScopesCursorInput = {
    v: 1,
    k: 'discord-scopes',
  }
  if (position.after !== undefined) payload.after = position.after
  if (position.skip > 0) payload.skip = position.skip
  return Encoding.encodeBase64Url(encodeDiscordScopesCursorJsonSync(payload))
}

/**
 * Opaque channels cursor: offset into the fully-enumerated guild-channel
 * list. The guild enumeration itself always scans every bot-visible guild
 * page, so channels are never limited to the first guild page; the offset
 * only paginates the final filtered list.
 */
const DiscordChannelsCursorPayload = Schema.Struct({
  v: Schema.Literal(1),
  k: Schema.Literal('discord-channels'),
  off: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
})
const DiscordChannelsCursorJson = Schema.fromJsonString(DiscordChannelsCursorPayload)
const decodeDiscordChannelsCursorJsonOption = Schema.decodeUnknownOption(DiscordChannelsCursorJson)
const encodeDiscordChannelsCursorJsonSync = Schema.encodeSync(DiscordChannelsCursorJson)

const decodeDiscordChannelsOffset = (cursor: string | undefined): Option.Option<number> => {
  if (cursor === undefined || cursor.trim() === '') return Option.some(0)
  const jsonResult = Encoding.decodeBase64UrlString(cursor.trim())
  if (!Result.isSuccess(jsonResult)) return Option.none()
  const payload = Option.getOrUndefined(
    decodeDiscordChannelsCursorJsonOption(Result.getOrThrow(jsonResult)),
  )
  if (payload === undefined) return Option.none()
  return Option.some(payload.off ?? 0)
}

const encodeDiscordChannelsOffset = (offset: number): string => {
  const payload: DiscordChannelsCursorInput = {
    v: 1,
    k: 'discord-channels',
  }
  if (offset > 0) payload.off = offset
  return Encoding.encodeBase64Url(encodeDiscordChannelsCursorJsonSync(payload))
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

const DiscordBotGuildRaw = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
})
const decodeDiscordBotGuild = Schema.decodeUnknownOption(DiscordBotGuildRaw)

const DiscordGuildChannelRaw = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Number),
  guild_id: Schema.optionalKey(Schema.String),
})
const decodeDiscordGuildChannel = Schema.decodeUnknownOption(DiscordGuildChannelRaw)

/** Guild text channel types listed as query/post targets; threads use the threads action. */
const isListableGuildChannelType = (type: number | undefined): boolean =>
  type === undefined || type === 0 || type === 5 || type === 15

const fetchOneGuildPage = Effect.fn('DiscordDiscovery.guildPage')(function* (
  discord: DiscordDiscoveryAdapter,
  after: string | undefined,
) {
  // Exactly one `GET /users/@me/guilds` page per scopes call, using the
  // native `limit`/`after` pagination. The `after` here is always a guild
  // id decoded from the opaque scopes cursor, never a numeric offset.
  const fetchOptions: DiscordBotGuildsOptions = { limit: DiscordGuildsPageSize }
  if (after !== undefined) fetchOptions.after = after
  return yield* Effect.tryPromise({
    try: () => discord.fetchBotGuilds(fetchOptions),
    catch: (cause) => discoverError(cause),
  })
})

/** Scans every bot-visible guild page so channel discovery never stops at the first page. */
const fetchAllVisibleGuildIds = Effect.fn('DiscordDiscovery.allVisibleGuilds')(function* (
  discord: DiscordDiscoveryAdapter,
) {
  const ids: Array<string> = []
  const seen = new Set<string>()
  let after: string | undefined
  for (;;) {
    const rows = yield* fetchOneGuildPage(discord, after)
    if (rows.length === 0) break
    for (const row of rows) {
      const guild = Option.getOrUndefined(decodeDiscordBotGuild(row))
      if (guild === undefined || guild.id.trim() === '' || seen.has(guild.id)) continue
      seen.add(guild.id)
      ids.push(guild.id)
    }
    if (rows.length < DiscordGuildsPageSize) break
    const last = Option.getOrUndefined(decodeDiscordBotGuild(rows[rows.length - 1]))
    const lastId = last?.id.trim()
    if (lastId === undefined || lastId === '' || lastId === after) break
    after = lastId
  }
  return ids
})

const discoverScopes = Effect.fn('DiscordDiscovery.scopes')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
) {
  const location = yield* decodeCurrentLocation(discord, String(query.binding.conversationId))
  const currentGuildId = location.guildId
  const positionOption = decodeDiscordScopesPosition(query.cursor)
  if (Option.isNone(positionOption)) {
    return yield* discoverError('invalid-cursor')
  }
  const position = positionOption.value
  const rows = yield* fetchOneGuildPage(discord, position.after)
  const filtered: Array<{ readonly id: string; readonly name: string | undefined }> = []
  for (const row of rows) {
    const guild = Option.getOrUndefined(decodeDiscordBotGuild(row))
    if (guild === undefined || guild.id.trim() === '') continue
    if (!matchesDiscoveryQuery([guild.id, guild.name], query.query)) continue
    filtered.push({ id: guild.id, name: guild.name })
  }
  const sliced = filtered.slice(position.skip, position.skip + query.limit)
  const remainingInPage = filtered.length - (position.skip + sliced.length)
  // Discord has no `next_cursor`: a full page may hide more guilds, so a
  // full page always continues honestly. Terminal pages carry no cursor.
  const hasMoreUpstream = rows.length >= DiscordGuildsPageSize
  const lastRowId = Option.getOrUndefined(decodeDiscordBotGuild(rows[rows.length - 1]))?.id.trim()
  const nextCursor =
    remainingInPage > 0
      ? encodeDiscordScopesPosition({ after: position.after, skip: position.skip + sliced.length })
      : hasMoreUpstream && lastRowId !== undefined && lastRowId !== ''
        ? encodeDiscordScopesPosition({ after: lastRowId, skip: 0 })
        : undefined
  const scopes: Array<PlatformDiscoveryScope> = sliced.map((entry) => ({
    kind: 'guild',
    id: entry.id,
    isCurrent: entry.id === currentGuildId,
  }))
  return {
    action: 'scopes' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    scopes,
    nextCursor,
    truncated: nextCursor !== undefined,
  } satisfies PlatformDiscoveryResult
})

const discoverChannels = Effect.fn('DiscordDiscovery.channels')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
) {
  const location = yield* decodeCurrentLocation(discord, String(query.binding.conversationId))
  const offsetOption = decodeDiscordChannelsOffset(query.cursor)
  if (Option.isNone(offsetOption)) {
    return yield* discoverError('invalid-cursor')
  }
  const offset = offsetOption.value
  // Guild enumeration always walks every `/users/@me/guilds` page so
  // channels span all bot-visible guilds, never just the first page.
  const visibleGuildIds = yield* fetchAllVisibleGuildIds(discord)
  const guilds = visibleGuildIds.filter(
    (guildId) => query.guildId === undefined || guildId === query.guildId,
  )
  const enriched: Array<{
    readonly guildId: string
    readonly channelId: string
    readonly name: string | undefined
  }> = []
  const seen = new Set<string>()
  for (const guildId of guilds) {
    const rows = yield* Effect.tryPromise({
      try: () => discord.fetchGuildChannels(guildId),
      catch: (cause) => discoverError(cause),
    })
    for (const row of rows) {
      const channel = Option.getOrUndefined(decodeDiscordGuildChannel(row))
      if (channel === undefined || channel.id.trim() === '') continue
      if (!isListableGuildChannelType(channel.type)) continue
      if (channel.guild_id !== undefined && channel.guild_id !== guildId) continue
      const key = `${guildId}:${channel.id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (!matchesDiscoveryQuery([channel.id, guildId, channel.name], query.query)) {
        continue
      }
      enriched.push({ guildId, channelId: channel.id, name: channel.name })
    }
  }
  const sliced = enriched.slice(offset, offset + query.limit)
  const nextCursor =
    offset + sliced.length < enriched.length
      ? encodeDiscordChannelsOffset(offset + sliced.length)
      : undefined
  const channels: Array<PlatformDiscoveryChannel> = []
  for (const entry of sliced) {
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
    nextCursor,
    truncated: nextCursor !== undefined,
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
  const parentInfo = yield* Effect.tryPromise({
    try: () =>
      discord.fetchChannelInfo(
        discord.encodeThreadId({ guildId: parentGuildId, channelId: parentChannelId }),
      ),
    catch: () => targetNotFound(),
  })
  const parentGuild = Option.getOrUndefined(
    decodeDiscordChannelGuild(parentInfo.metadata.raw),
  )?.guild_id
  if (parentGuild !== undefined && parentGuild !== parentGuildId) {
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
    catch: (cause) => {
      const status = discordHttpStatus(cause)
      return status === 401 || status === 403 || status === 404
        ? targetNotFound()
        : discoverError(cause)
    },
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
 * Read-only Discord discovery through the current connection only. Scopes read
 * exactly one `GET /users/@me/guilds` page per call with native
 * `limit`/`after` pagination inside an opaque continuation cursor; channels
 * scan every guild page before listing bot-visible guild text channels via
 * `GET /guilds/{guild}/channels` and paginate the filtered list with an
 * opaque offset cursor. Names come from those payloads and never fail the
 * listing. Threads use the native thread list on a visible parent channel.
 * Invisible parents collapse to not-found without revealing existence.
 * Friday admission config never gates discovery.
 */
export const discoverDiscord = Effect.fn('DiscordDiscovery.discover')(function* (
  discord: DiscordDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
) {
  switch (query.action) {
    case 'current':
      return yield* discoverCurrent(discord, query)
    case 'scopes':
      return yield* discoverScopes(discord, query)
    case 'channels':
      return yield* discoverChannels(discord, query)
    case 'threads':
      return yield* discoverThreads(discord, query)
  }
})
