/* oxlint-disable anti-slop/no-unknown-returns -- Structural Slack WebClient surface; every response is Schema-decoded at its call site. */

import type { SlackAdapter } from '@chat-adapter/slack'
import type { ListThreadsOptions } from 'chat'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
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
import {
  isSlackDirectMessageChannel,
  type SlackResolvedChannelPolicy,
} from './SlackChannelAccess.ts'

/**
 * Minimal structural surface for Slack membership reads. The full
 * `@slack/web-api` WebClient satisfies this; responses decode as unknown so
 * no new dependency or exact SDK typing is required.
 */
export interface SlackDiscoveryWebClient {
  readonly conversations: {
    readonly members: (args: SlackChannelMembersArgs) => Promise<unknown>
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
   * targets outside it fail closed before policy lookup or any adapter call.
   */
  readonly workspaceId: string
  readonly resolveChannelPolicy: (
    teamId: string,
    channelId: string,
  ) => SlackResolvedChannelPolicy | undefined
  /**
   * Configured per-channel override IDs; admission still decides per channel.
   * Absent in tests: discovery then returns the current channel only.
   */
  readonly listKnownChannels?: (() => ReadonlyArray<string>) | undefined
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
 * Resolves an explicit Slack target against the connection's bound workspace
 * and the live admission policy. Mirrors the query/post gate: workspace
 * mismatches and unadmitted channels collapse to a generic not-found before
 * any adapter call.
 */
const resolveSlackTarget = (
  target: SlackQueryTarget,
  policy: SlackDiscoveryPolicy,
): Effect.Effect<SlackResolvedTarget, PlatformTargetNotFoundError> =>
  Effect.gen(function* () {
    if (target.workspaceId !== policy.workspaceId) {
      return yield* targetNotFound()
    }
    if (policy.resolveChannelPolicy(target.workspaceId, target.channelId) === undefined) {
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

const discoverChannels = Effect.fn('SlackDiscovery.channels')(function* (
  adapter: SlackDiscoveryAdapter,
  query: PlatformDiscoveryQuery,
  policy: SlackDiscoveryPolicy,
) {
  const location = decodeSlackConversationId(String(query.binding.conversationId))
  const candidates = new Set<string>()
  for (const channelId of policy.listKnownChannels?.() ?? []) candidates.add(channelId)
  if (location !== undefined) candidates.add(location.channelId)
  const enriched: Array<{ readonly channelId: string; readonly name: string | undefined }> = []
  for (const channelId of candidates) {
    if (policy.workspaceId === '') continue
    if (policy.resolveChannelPolicy(policy.workspaceId, channelId) === undefined) continue
    const name = yield* channelName(adapter, channelId)
    if (!matchesDiscoveryQuery([channelId, name], query.query)) continue
    enriched.push({ channelId, name })
  }
  const page = yield* paginateIds(
    enriched.map((entry) => entry.channelId),
    query.limit,
    query.cursor,
  )
  const channels: Array<PlatformDiscoveryChannel> = []
  for (const channelId of page.page) {
    const entry = enriched.find((item) => item.channelId === channelId)
    if (entry === undefined) continue
    channels.push({
      target: { platform: 'slack', workspaceId: policy.workspaceId, channelId },
      name: entry.name,
      isCurrent: location?.channelId === channelId,
      isDirectMessage: isSlackDirectMessageChannel(channelId),
    })
  }
  return {
    action: 'channels' as const,
    platform: query.binding.platform,
    connectionId: query.binding.connectionId,
    workspaceId: policy.workspaceId,
    channels,
    nextCursor: page.nextCursor,
    truncated: page.truncated,
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
 * Channels enumerate policy-known IDs (configured overrides plus the current
 * channel) admitted by the live channel scope; threads use the native thread
 * list on an admitted parent channel.
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
