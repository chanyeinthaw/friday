/* oxlint-disable anti-slop/no-unknown-returns -- Structural Slack WebClient surface; every response is Schema-decoded at its call site. */

import type { SlackAdapter } from '@chat-adapter/slack'
import type { ListThreadsOptions } from 'chat'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'

import {
  isSlackThreadTarget,
  PlatformMembersUnsupportedError,
  PlatformTargetNotFoundError,
  type PlatformDiscoveryChannel,
  type PlatformDiscoveryQuery,
  type PlatformDiscoveryResult,
  type PlatformDiscoveryScope,
  type PlatformDiscoveryThread,
  type PlatformMember,
  type PlatformMembersQuery,
  type PlatformMembersResult,
  type SlackQueryTarget,
} from '../PlatformAdapter.ts'
import { decodeDiscoveryOffset, matchesDiscoveryQuery } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import {
  decodeSlackAdapterThreadId,
  decodeSlackConversationId,
  toSlackAdapterChannelId,
} from './SlackConversationScope.ts'
import { isSlackDirectMessageChannel } from './SlackChannelAccess.ts'

/**
 * Minimal structural surface for Slack membership and channel reads. The full
 * `@slack/web-api` WebClient satisfies this; responses decode as unknown so
 * no new dependency or exact SDK typing is required.
 */
export interface SlackDiscoveryWebClient {
  readonly conversations: {
    readonly members: (args: SlackChannelMembersArgs) => Promise<unknown>
    readonly list: (args: SlackChannelListArgs) => Promise<unknown>
  }
  readonly users: {
    readonly info: (args: { readonly user: string }) => Promise<unknown>
  }
}

/**
 * Channel member page arguments. Fields stay mutable so callers can attach
 * the pagination cursor in a separate statement.
 */
export interface SlackChannelMembersArgs {
  channel: string
  cursor?: string
  limit?: number
}

/**
 * Channel list arguments for visible-scope discovery. Fields stay mutable so
 * callers can attach the pagination cursor in a separate statement.
 */
export interface SlackChannelListArgs {
  types?: string
  limit?: number
  cursor?: string
}

/** Transport needed for explicit-target Slack member listing and discovery. */
export interface SlackDiscoveryAdapter extends Pick<
  SlackAdapter,
  'fetchChannelInfo' | 'listThreads'
> {
  readonly webClient: SlackDiscoveryWebClient
}

export interface SlackDiscoveryPolicy {
  /**
   * Single workspace (team) bound to this connection's bot token. Explicit
   * targets outside it fail closed before any adapter call. Channel
   * visibility is established by Slack API responses, never by Friday
   * admission config.
   */
  readonly workspaceId: string
}

const targetNotFound = () => new PlatformTargetNotFoundError({ kind: 'slack' })
const discoverError = (cause: unknown) =>
  new ChatSdkPublicationError({ operation: 'discover', cause })
const membersError = (cause: unknown) =>
  new ChatSdkPublicationError({ operation: 'list-members', cause })

const SlackErrorCode = Schema.Struct({
  data: Schema.Struct({ error: Schema.String }),
})
const decodeSlackErrorCode = Schema.decodeUnknownOption(SlackErrorCode)
const slackErrorCode = (cause: unknown): string | undefined =>
  Option.getOrUndefined(decodeSlackErrorCode(cause))?.data.error

const SlackMembersPage = Schema.Struct({
  members: Schema.optionalKey(Schema.Array(Schema.String)),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
  ),
})
const decodeSlackMembersPage = Schema.decodeUnknownOption(SlackMembersPage)

const SlackUserInfo = Schema.Struct({
  user: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      real_name: Schema.optionalKey(Schema.String),
      is_bot: Schema.optionalKey(Schema.Boolean),
      profile: Schema.optionalKey(
        Schema.Struct({
          display_name: Schema.optionalKey(Schema.String),
          real_name: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
})
type SlackMemberProfile = typeof SlackUserInfo.Type
const decodeSlackUserInfo = Schema.decodeUnknownOption(SlackUserInfo)

/** Slack codes that mean the channel is not accessible: collapse to not-found. */
const isSlackInaccessibleCode = (code: string | undefined): boolean =>
  code === 'channel_not_found' ||
  code === 'not_in_channel' ||
  code === 'restricted_action' ||
  code === 'action_not_allowed'

interface SlackResolvedTarget {
  readonly teamId: string
  readonly channelId: string
  readonly threadTs: string | undefined
}

/**
 * Resolves an explicit Slack target against the connection's bound workspace.
 * Workspace mismatches collapse to a generic not-found before any adapter
 * call. Channel visibility is established by subsequent Slack API responses;
 * Friday admission config never gates tool targets.
 */
const resolveSlackTarget = (
  target: SlackQueryTarget,
  policy: SlackDiscoveryPolicy,
): Effect.Effect<SlackResolvedTarget, PlatformTargetNotFoundError> =>
  Effect.gen(function* () {
    if (target.workspaceId !== policy.workspaceId) {
      return yield* targetNotFound()
    }
    return {
      teamId: target.workspaceId,
      channelId: target.channelId,
      threadTs: target.threadTs,
    }
  })

const memberFromProfile = (userId: string, info: SlackMemberProfile['user']): PlatformMember => {
  const username = info?.name ?? userId
  const displayName =
    info?.profile?.display_name !== undefined && info.profile.display_name !== ''
      ? info.profile.display_name
      : (info?.real_name ?? info?.profile?.real_name ?? username)
  return {
    platformUserId: userId,
    username,
    displayName: displayName ?? userId,
    mention: `<@${userId}>`,
    isBot: info?.is_bot ?? 'unknown',
  }
}

const idOnlyMember = (userId: string): PlatformMember => ({
  platformUserId: userId,
  username: userId,
  displayName: userId,
  mention: `<@${userId}>`,
  isBot: 'unknown',
})

/**
 * Lists members of an explicit Slack channel target through
 * `conversations.members`. Thread targets inherit their parent channel
 * membership: Slack threads have no separate roster. Names resolve through
 * bounded `users.info` lookups and fall back to IDs-only entries when the
 * profile scope is missing; per-user lookup failures never fail the page.
 */
export const listSlackMembers = Effect.fn('SlackDiscovery.listMembers')(function* (
  adapter: SlackDiscoveryAdapter,
  query: PlatformMembersQuery,
  policy: SlackDiscoveryPolicy,
) {
  if (query.target.platform !== 'slack') return yield* targetNotFound()
  const resolved = yield* resolveSlackTarget(query.target, policy)
  const seen = new Set<string>()
  const members: Array<PlatformMember> = []
  let cursor: string | undefined
  let hasMore = true
  // Flips to IDs-only after the first missing profile scope instead of burning
  // one lookup per member. Per-user failures still fall back individually.
  let profileLookupsAllowed = true
  const lookupProfile = (userId: string): Effect.Effect<PlatformMember, never> => {
    if (!profileLookupsAllowed) return Effect.succeed(idOnlyMember(userId))
    // The inner rejection handler keeps Slack failures in the success channel
    // so the scope fallback below never touches Effect error recovery.
    const settled = (): Promise<
      | { readonly ok: true; readonly profile: unknown }
      | { readonly ok: false; readonly cause: unknown }
    > =>
      adapter.webClient.users.info({ user: userId }).then(
        (profile) => ({ ok: true as const, profile }),
        (cause: unknown) => ({ ok: false as const, cause }),
      )
    return Effect.promise(settled).pipe(
      Effect.map((outcome) => {
        if (outcome.ok) {
          const info = Option.getOrUndefined(decodeSlackUserInfo(outcome.profile))?.user
          return memberFromProfile(userId, info)
        }
        const code = slackErrorCode(outcome.cause)
        if (code === 'missing_scope' || code === 'not_allowed_token_type') {
          profileLookupsAllowed = false
        }
        return idOnlyMember(userId)
      }),
    )
  }
  while (members.length < query.limit && hasMore) {
    const memberArgs: SlackChannelMembersArgs = {
      channel: resolved.channelId,
      limit: Math.min(query.limit - members.length, 50),
    }
    if (cursor !== undefined) memberArgs.cursor = cursor
    const raw = yield* Effect.tryPromise({
      try: () => adapter.webClient.conversations.members(memberArgs),
      catch: (cause) => {
        const code = slackErrorCode(cause)
        return isSlackInaccessibleCode(code)
          ? targetNotFound()
          : membersError(`slack-conversations-members:${code ?? 'unknown'}`)
      },
    })
    const page = Option.getOrUndefined(decodeSlackMembersPage(raw))
    const ids = page?.members ?? []
    for (const userId of ids) {
      if (userId === '' || seen.has(userId)) continue
      seen.add(userId)
      members.push(yield* lookupProfile(userId))
      if (members.length >= query.limit) break
    }
    const next = page?.response_metadata?.next_cursor
    cursor = next === undefined || next === '' ? undefined : next
    hasMore = cursor !== undefined
  }
  return {
    members,
    nextCursor: cursor,
    truncated: hasMore,
  } satisfies PlatformMembersResult
})

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

const channelName = (
  adapter: SlackDiscoveryAdapter,
  channelId: string,
): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({
    try: () => adapter.fetchChannelInfo(toSlackAdapterChannelId({ channelId })),
    catch: () => undefined,
  }).pipe(
    Effect.map((info) => (info === undefined ? undefined : info.name)),
    Effect.orElseSucceed(() => undefined),
  )

const discoverCurrent = Effect.fn('SlackDiscovery.current')(function* (
  adapter: SlackDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
) {
  const location = decodeSlackConversationId(String(query.binding.conversationId))
  if (location === undefined) {
    return yield* discoverError('unknown-binding')
  }
  const isThread = location.threadTs !== undefined
  const target: SlackQueryTarget = isThread
    ? {
        platform: 'slack',
        workspaceId: location.teamId,
        channelId: location.channelId,
        threadTs: location.threadTs,
      }
    : { platform: 'slack', workspaceId: location.teamId, channelId: location.channelId }
  const name = yield* channelName(adapter, location.channelId)
  return {
    target,
    targetType: isThread ? ('thread' as const) : ('channel' as const),
    name,
    isDirectMessage: isSlackDirectMessageChannel(location.channelId),
  }
})

const discoverScopes = Effect.fn('SlackDiscovery.scopes')(function* (
  query: PlatformDiscoveryQuery,
  policy: SlackDiscoveryPolicy,
) {
  const location = decodeSlackConversationId(String(query.binding.conversationId))
  const scopes: Array<PlatformDiscoveryScope> =
    policy.workspaceId === '' || !matchesDiscoveryQuery([policy.workspaceId], query.query)
      ? []
      : [
          {
            kind: 'workspace',
            id: policy.workspaceId,
            isCurrent: location?.teamId === policy.workspaceId,
          },
        ]
  const page = yield* paginateIds(
    scopes.map((scope) => scope.id),
    query.limit,
    query.cursor,
  )
  return {
    action: 'scopes' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    workspaceId: policy.workspaceId,
    scopes: scopes.filter((scope) => page.page.includes(scope.id)),
    nextCursor: page.nextCursor,
    truncated: page.truncated,
  } satisfies PlatformDiscoveryResult
})

const SlackChannelListPage = Schema.Struct({
  channels: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  response_metadata: Schema.optionalKey(
    Schema.Struct({ next_cursor: Schema.optionalKey(Schema.String) }),
  ),
})
const decodeSlackChannelListPage = Schema.decodeUnknownOption(SlackChannelListPage)

const ChannelListPageSize = 200

/**
 * Opaque composite cursor for channel discovery. `api` is the Slack
 * `conversations.list` `next_cursor` for the page to fetch; `skip` is the
 * local offset into that page's query-filtered channels when a previous
 * call truncated inside one API page. Both travel base64url-encoded so
 * numeric offsets never reach Slack as cursors.
 */
const SlackChannelsCursorPayload = Schema.Struct({
  v: Schema.Literal(1),
  k: Schema.Literal('slack-channels'),
  api: Schema.optionalKey(Schema.String),
  skip: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
})
const SlackChannelsCursorJson = Schema.fromJsonString(SlackChannelsCursorPayload)
const decodeSlackChannelsCursorJsonOption = Schema.decodeUnknownOption(SlackChannelsCursorJson)
const encodeSlackChannelsCursorJsonSync = Schema.encodeSync(SlackChannelsCursorJson)

interface SlackChannelsPosition {
  readonly api: string | undefined
  readonly skip: number
}

interface SlackChannelsCursorInput {
  readonly v: 1
  readonly k: 'slack-channels'
  api?: string
  skip?: number
}

const decodeSlackChannelsPosition = (
  cursor: string | undefined,
): Option.Option<SlackChannelsPosition> => {
  if (cursor === undefined || cursor.trim() === '') {
    return Option.some({ api: undefined, skip: 0 })
  }
  const jsonResult = Encoding.decodeBase64UrlString(cursor.trim())
  if (!Result.isSuccess(jsonResult)) return Option.none()
  const payload = Option.getOrUndefined(
    decodeSlackChannelsCursorJsonOption(Result.getOrThrow(jsonResult)),
  )
  if (payload === undefined) return Option.none()
  const api = payload.api === undefined || payload.api === '' ? undefined : payload.api
  return Option.some({ api, skip: payload.skip ?? 0 })
}

const encodeSlackChannelsPosition = (position: SlackChannelsPosition): string => {
  const payload: SlackChannelsCursorInput = {
    v: 1,
    k: 'slack-channels',
  }
  if (position.api !== undefined) payload.api = position.api
  if (position.skip > 0) payload.skip = position.skip
  return Encoding.encodeBase64Url(encodeSlackChannelsCursorJsonSync(payload))
}

const fetchOneSlackChannelPage = Effect.fn('SlackDiscovery.channelPage')(function* (
  adapter: SlackDiscoveryAdapter,
  apiCursor: string | undefined,
) {
  // Exactly one `conversations.list` page per tool call. Public and private
  // channels only; DMs use their own flows and are not enumerated here.
  // The cursor here is always Slack's opaque `next_cursor`, never a numeric
  // offset: numeric continuation lives inside the opaque composite cursor.
  const listArgs: SlackChannelListArgs = {
    types: 'public_channel,private_channel',
    limit: ChannelListPageSize,
  }
  if (apiCursor !== undefined) listArgs.cursor = apiCursor
  const raw = yield* Effect.tryPromise({
    try: () => adapter.webClient.conversations.list(listArgs),
    catch: (cause) => {
      const code = slackErrorCode(cause)
      return isSlackInaccessibleCode(code)
        ? targetNotFound()
        : discoverError(`slack-conversations-list:${code ?? 'unknown'}`)
    },
  })
  return Option.getOrUndefined(decodeSlackChannelListPage(raw))
})

interface SlackFilteredPage {
  readonly filtered: Array<{ readonly channelId: string; readonly name: string | undefined }>
  readonly seen: Set<string>
}

const collectSlackFiltered = (
  channels: ReadonlyArray<{ readonly id: string; readonly name?: string | undefined }>,
  needle: string | undefined,
): SlackFilteredPage => {
  const seen = new Set<string>()
  const filtered: Array<{ readonly channelId: string; readonly name: string | undefined }> = []
  for (const channel of channels) {
    const channelId = channel.id.trim()
    if (channelId === '' || seen.has(channelId)) continue
    seen.add(channelId)
    if (!matchesDiscoveryQuery([channelId, channel.name], needle)) continue
    filtered.push({ channelId, name: channel.name })
  }
  return { filtered, seen }
}

const nextSlackChannelsCursor = (
  position: SlackChannelsPosition,
  slicedLength: number,
  remainingInPage: number,
  nextApi: string | undefined,
): string | undefined => {
  // Honest continuation: `truncated` is true whenever the current API page
  // still holds unreturned matches or Slack reports another upstream page.
  // Terminal pages carry no cursor; every truncated page carries one.
  if (remainingInPage > 0) {
    return encodeSlackChannelsPosition({ api: position.api, skip: position.skip + slicedLength })
  }
  if (nextApi !== undefined) return encodeSlackChannelsPosition({ api: nextApi, skip: 0 })
  return undefined
}

const discoverChannels = Effect.fn('SlackDiscovery.channels')(function* (
  adapter: SlackDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
  policy: SlackDiscoveryPolicy,
) {
  const location = decodeSlackConversationId(String(query.binding.conversationId))
  if (policy.workspaceId === '') {
    const empty = yield* paginateIds([], query.limit, query.cursor)
    return {
      action: 'channels' as const,
      platform: query.binding.platform,
      connectionId: query.binding.connectionId,
      workspaceId: policy.workspaceId,
      channels: [],
      nextCursor: empty.nextCursor,
      truncated: empty.truncated,
    } satisfies PlatformDiscoveryResult
  }
  const positionOption = decodeSlackChannelsPosition(query.cursor)
  if (Option.isNone(positionOption)) {
    return yield* discoverError('invalid-cursor')
  }
  const position = positionOption.value
  const page = yield* fetchOneSlackChannelPage(adapter, position.api)
  const collected = collectSlackFiltered(page?.channels ?? [], query.query)
  const filtered = [...collected.filtered]
  // Include the current channel on the first page only when the list omits
  // it but it remains readable; visibility is proven by the name read.
  // Rebuilt identically on every fetch of the first page so `skip` resumes
  // deterministically without storing channel contents in the cursor.
  if (position.api === undefined && position.skip === 0 && location !== undefined) {
    if (!collected.seen.has(location.channelId)) {
      const name = yield* channelName(adapter, location.channelId)
      if (name !== undefined && matchesDiscoveryQuery([location.channelId, name], query.query)) {
        filtered.push({ channelId: location.channelId, name })
      }
    }
  }
  const sliced = filtered.slice(position.skip, position.skip + query.limit)
  const remainingInPage = filtered.length - (position.skip + sliced.length)
  const following = page?.response_metadata?.next_cursor
  const nextApi = following === undefined || following === '' ? undefined : following
  const nextCursor = nextSlackChannelsCursor(position, sliced.length, remainingInPage, nextApi)
  const channels: Array<PlatformDiscoveryChannel> = sliced.map((entry) => ({
    target: { platform: 'slack', workspaceId: policy.workspaceId, channelId: entry.channelId },
    name: entry.name,
    isCurrent: location?.channelId === entry.channelId,
    isDirectMessage: isSlackDirectMessageChannel(entry.channelId),
  }))
  return {
    action: 'channels' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    workspaceId: policy.workspaceId,
    channels,
    nextCursor,
    truncated: nextCursor !== undefined,
  } satisfies PlatformDiscoveryResult
})

const discoverThreads = Effect.fn('SlackDiscovery.threads')(function* (
  adapter: SlackDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
  policy: SlackDiscoveryPolicy,
) {
  const parent = query.channelTarget
  if (parent === undefined || parent.platform !== 'slack' || isSlackThreadTarget(parent)) {
    return yield* new PlatformMembersUnsupportedError({
      kind: 'slack',
      detail: 'Thread discovery requires an explicit Slack channel target.',
    })
  }
  const resolved = yield* resolveSlackTarget(parent, policy).pipe(
    Effect.mapError(() => targetNotFound()),
  )
  const location = decodeSlackConversationId(String(query.binding.conversationId))
  const threadOptions: ListThreadsOptions = {
    limit: Math.min(query.limit, 50),
  }
  if (query.cursor !== undefined) threadOptions.cursor = query.cursor
  const listed = yield* Effect.tryPromise({
    try: () =>
      adapter.listThreads(
        toSlackAdapterChannelId({ channelId: resolved.channelId }),
        threadOptions,
      ),
    catch: (cause) => {
      const code = slackErrorCode(cause)
      return isSlackInaccessibleCode(code)
        ? targetNotFound()
        : discoverError(`slack-list-threads:${code ?? 'unknown'}`)
    },
  })
  const threads: Array<PlatformDiscoveryThread> = []
  for (const thread of listed.threads) {
    if (threads.length >= query.limit) break
    const decoded = decodeSlackAdapterThreadId(thread.id)
    if (decoded === undefined || decoded.threadTs === undefined) continue
    if (decoded.channelId !== resolved.channelId) continue
    const text = thread.rootMessage.text.trim()
    if (!matchesDiscoveryQuery([decoded.threadTs, text], query.query)) continue
    const threadName = text === '' ? undefined : text.slice(0, 80)
    threads.push({
      target: {
        platform: 'slack',
        workspaceId: resolved.teamId,
        channelId: resolved.channelId,
        threadTs: decoded.threadTs,
      },
      name: threadName,
      rootSnippet: text === '' ? undefined : text.slice(0, 160),
      replyCount: thread.replyCount,
      isCurrent: location?.threadTs === decoded.threadTs,
    })
  }
  return {
    action: 'threads' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    workspaceId: policy.workspaceId,
    threads,
    nextCursor: listed.nextCursor,
    truncated: listed.nextCursor !== undefined,
  } satisfies PlatformDiscoveryResult
})

/**
 * Read-only Slack discovery through the current connection only. The workspace
 * is always the connection-bound team from `auth.test`, never model input.
 * Channels read exactly one `conversations.list` page per call and continue
 * through Slack's opaque `next_cursor` inside an opaque composite cursor
 * (API cursor plus local skip); threads use the native thread list on a
 * visible parent channel. Visibility is established by Slack API responses;
 * Friday admission config never gates discovery.
 */
export const discoverSlack = Effect.fn('SlackDiscovery.discover')(function* (
  adapter: SlackDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
  policy: SlackDiscoveryPolicy,
) {
  switch (query.action) {
    case 'current': {
      const current = yield* discoverCurrent(adapter, query)
      return {
        action: 'current' as const,
        platform: query.binding.platform,
        connectionId: query.binding.connectionId,
        workspaceId: policy.workspaceId,
        current,
      } satisfies PlatformDiscoveryResult
    }
    case 'scopes':
      return yield* discoverScopes(query, policy)
    case 'channels':
      return yield* discoverChannels(adapter, query, policy)
    case 'threads':
      return yield* discoverThreads(adapter, query, policy)
  }
})
