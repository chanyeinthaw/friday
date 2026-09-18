import type {
  ConversationBinding,
  ContextMessage,
  ImageAttachment,
  InputMessage,
  PlatformMessageId,
} from '@friday/contracts/conversation'
import type * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

export interface PlatformInput {
  readonly binding: ConversationBinding
  readonly message: InputMessage
  readonly initialContext?: ReadonlyArray<ContextMessage>
  /** Preferred history source; `discordHistorySource` remains as a deprecated alias. */
  readonly historySource?: 'channel' | 'thread'
  /** @deprecated Use `historySource`; kept for Discord compatibility. */
  readonly discordHistorySource?: 'channel' | 'thread'
}

/** Reads the normalized history source across the renamed field and its Discord alias. */
export const platformHistorySource = (input: PlatformInput): 'channel' | 'thread' | undefined =>
  input.historySource ?? input.discordHistorySource

/**
 * Decodes an offset pagination cursor for policy-snapshot discovery listings.
 * Absent cursors start at zero; Some(offset) is the validated start index and
 * None means the cursor is malformed and the caller must fail closed.
 */
export const decodeDiscoveryOffset = (cursor: string | undefined): Option.Option<number> => {
  if (cursor === undefined || cursor.trim() === '') return Option.some(0)
  const offset = Number(cursor.trim())
  return Number.isInteger(offset) && offset >= 0 ? Option.some(offset) : Option.none()
}

/**
 * Case-insensitive substring match for discovery search filters. An absent or
 * blank needle matches everything; otherwise at least one defined haystack
 * must contain it.
 */
export const matchesDiscoveryQuery = (
  haystacks: ReadonlyArray<string | undefined>,
  needle: string | undefined,
): boolean => {
  if (needle === undefined || needle.trim() === '') return true
  const lowered = needle.trim().toLocaleLowerCase()
  return haystacks.some((haystack) => haystack?.toLocaleLowerCase().includes(lowered) === true)
}

export interface PlatformMessageRecord {
  readonly id: PlatformMessageId
  readonly author: ContextMessage['author']
  readonly text: string
  readonly sentAt: string | null
  readonly replyToMessageId: PlatformMessageId | null
  /** Projected Discord attachments (images, HTML, Markdown, plain text). Empty when none. */
  readonly attachments: ReadonlyArray<ImageAttachment>
}

const TargetId = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

/**
 * Explicit Discord query/post target. A `threadId` addresses a thread (with an
 * optional parent `channelId` hint); otherwise `channelId` addresses a channel.
 * Guild-scoped only: direct messages have no guild and are never valid targets.
 */
const DiscordQueryTargetRaw = Schema.Struct({
  platform: Schema.Literal('discord'),
  guildId: TargetId,
  channelId: Schema.optionalKey(TargetId),
  threadId: Schema.optionalKey(TargetId),
})
type DiscordQueryTargetRaw = typeof DiscordQueryTargetRaw.Type

export const DiscordQueryTarget = DiscordQueryTargetRaw.pipe(
  Schema.check(
    Schema.makeFilter((target: DiscordQueryTargetRaw): string | undefined =>
      target.threadId !== undefined || target.channelId !== undefined
        ? undefined
        : 'Discord targets need a channelId, or a threadId with an optional parent channelId.',
    ),
  ),
)
export type DiscordQueryTarget = typeof DiscordQueryTarget.Type

/** True when the target is a Discord thread target rather than a channel target. */
export const isDiscordThreadTarget = (
  target: PlatformQueryTarget,
): target is DiscordQueryTarget & { readonly threadId: string } =>
  target.platform === 'discord' && target.threadId !== undefined

/**
 * Explicit Slack query/post target. A `threadTs` addresses a thread; otherwise
 * `channelId` addresses the channel root.
 */
export const SlackQueryTarget = Schema.Struct({
  platform: Schema.Literal('slack'),
  workspaceId: TargetId,
  channelId: TargetId,
  threadTs: Schema.optionalKey(TargetId),
})
export type SlackQueryTarget = typeof SlackQueryTarget.Type

/** True when the target is a Slack thread target rather than a channel target. */
export const isSlackThreadTarget = (
  target: PlatformQueryTarget,
): target is SlackQueryTarget & { readonly threadTs: string } =>
  target.platform === 'slack' && target.threadTs !== undefined

/**
 * Explicit platform target for queries and posts. Targets always resolve
 * through the current thread's existing platform connection: there is no
 * `connectionId` input, no cross-connection selection, and the target
 * platform must match the current connection kind. A single shared shape
 * keeps query and post validation identical.
 */
export const PlatformQueryTarget = Schema.Union([DiscordQueryTarget, SlackQueryTarget])
export type PlatformQueryTarget = typeof PlatformQueryTarget.Type

/**
 * Generic not-found for target admission. Unknown, disabled, unadmitted,
 * inaccessible, and missing search/post targets collapse here so reads and
 * posts never expose channel existence. Single-message retrieval keeps its
 * own `PlatformMessageNotFoundError`.
 */
export class PlatformTargetNotFoundError extends Schema.Error<PlatformTargetNotFoundError>(
  'PlatformTargetNotFoundError',
)({
  _tag: Schema.tag('PlatformTargetNotFoundError'),
  kind: Schema.String,
}) {
  override get message(): string {
    return 'Target not found or not accessible.'
  }
}

export interface PlatformMessageQuery {
  readonly binding: ConversationBinding
  readonly target: PlatformQueryTarget
  readonly limit: number
  readonly before?: PlatformMessageId | undefined
  readonly query?: string | undefined
  readonly authorId?: string | undefined
}

export interface PlatformMessageSearchResult {
  readonly messages: ReadonlyArray<PlatformMessageRecord>
  readonly scannedCount: number
  readonly truncated: boolean
}

export interface PlatformMessageTarget {
  readonly binding: ConversationBinding
  readonly messageId: PlatformMessageId
}

/**
 * One channel or thread member with only the fields the model needs to
 * identify participants. Usernames and display names are untrusted and
 * changeable; the canonical `platformUserId` is the stable identity. Emails,
 * profile metadata beyond names, roles, permissions, and presence are never
 * exposed here.
 */
export interface PlatformMember {
  readonly platformUserId: string
  readonly username: string
  readonly displayName: string
  readonly mention: string
  readonly isBot: boolean | 'unknown'
}

export interface PlatformMembersQuery {
  readonly binding: ConversationBinding
  readonly target: PlatformQueryTarget
  readonly limit: number
  readonly cursor?: string | undefined
}

export interface PlatformMembersResult {
  readonly members: ReadonlyArray<PlatformMember>
  readonly nextCursor?: string | undefined
  readonly truncated: boolean
}

/**
 * Honest unsupported scope for member listing. Discord channel targets have
 * no bounded reliable member API (guild member listing is privileged and
 * expensive), so only thread targets are supported there; Slack thread
 * targets inherit their parent channel membership. Unlike not-found, this
 * never hides an admitted target: it names the limitation.
 */
export class PlatformMembersUnsupportedError extends Schema.Error<PlatformMembersUnsupportedError>(
  'PlatformMembersUnsupportedError',
)({
  _tag: Schema.tag('PlatformMembersUnsupportedError'),
  kind: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail
  }
}

/** Discovery actions for the read-only `discover_platforms` tool. */
export type PlatformDiscoveryAction = 'current' | 'scopes' | 'channels' | 'threads'

export interface PlatformDiscoveryQuery {
  readonly binding: ConversationBinding
  readonly action: PlatformDiscoveryAction
  /** Discord-only guild filter for the `channels` action. Omit for all admitted guilds. */
  readonly guildId?: string | undefined
  /** Explicit parent channel target for the `threads` action. Must be a channel, not a thread. */
  readonly channelTarget?: PlatformQueryTarget | undefined
  /** Optional case-insensitive substring filter over names and IDs. */
  readonly query?: string | undefined
  readonly limit: number
  /** Opaque pagination cursor: offset string for scopes/channels, adapter cursor for threads. */
  readonly cursor?: string | undefined
}

export interface PlatformDiscoveryCurrentTarget {
  readonly target: PlatformQueryTarget
  readonly targetType: 'channel' | 'thread'
  readonly name?: string | undefined
  readonly isDirectMessage: boolean
}

export interface PlatformDiscoveryScope {
  readonly kind: 'guild' | 'workspace'
  readonly id: string
  readonly isCurrent: boolean
}

export interface PlatformDiscoveryChannel {
  readonly target: PlatformQueryTarget
  readonly name?: string | undefined
  readonly isCurrent: boolean
  readonly isDirectMessage: boolean
}

export interface PlatformDiscoveryThread {
  readonly target: PlatformQueryTarget
  readonly name?: string | undefined
  readonly rootSnippet?: string | undefined
  readonly replyCount?: number | undefined
  readonly isCurrent: boolean
}

export type PlatformDiscoveryResult =
  | {
      readonly action: 'current'
      readonly platform: ConversationBinding['platform']
      readonly connectionId: ConversationBinding['connectionId']
      readonly workspaceId?: string | undefined
      readonly current: PlatformDiscoveryCurrentTarget
    }
  | {
      readonly action: 'scopes'
      readonly platform: ConversationBinding['platform']
      readonly connectionId: ConversationBinding['connectionId']
      readonly workspaceId?: string | undefined
      readonly scopes: ReadonlyArray<PlatformDiscoveryScope>
      readonly nextCursor?: string | undefined
      readonly truncated: boolean
    }
  | {
      readonly action: 'channels'
      readonly platform: ConversationBinding['platform']
      readonly connectionId: ConversationBinding['connectionId']
      readonly workspaceId?: string | undefined
      readonly channels: ReadonlyArray<PlatformDiscoveryChannel>
      readonly nextCursor?: string | undefined
      readonly truncated: boolean
    }
  | {
      readonly action: 'threads'
      readonly platform: ConversationBinding['platform']
      readonly connectionId: ConversationBinding['connectionId']
      readonly workspaceId?: string | undefined
      readonly threads: ReadonlyArray<PlatformDiscoveryThread>
      readonly nextCursor?: string | undefined
      readonly truncated: boolean
    }

/** Generic not-found for single-message retrieval. Inaccessible and missing targets collapse here. */
export class PlatformMessageNotFoundError extends Schema.Error<PlatformMessageNotFoundError>(
  'PlatformMessageNotFoundError',
)({
  _tag: Schema.tag('PlatformMessageNotFoundError'),
  kind: Schema.String,
  messageId: Schema.String,
}) {
  override get message(): string {
    return 'Message not found.'
  }
}

export interface PlatformMessageGetQuery {
  readonly binding: ConversationBinding
  readonly target?: PlatformQueryTarget | undefined
  readonly messageId?: PlatformMessageId | undefined
  readonly messageUrl?: string | undefined
}

export interface PlatformMessagePostQuery {
  readonly binding: ConversationBinding
  readonly target: PlatformQueryTarget
  readonly text: string
}

export interface PlatformMessagePostResult {
  /**
   * Native platform message id when the transport exposes one. Null means the
   * post succeeded without an exposed id; ids are never fabricated.
   */
  readonly messageId: PlatformMessageId | null
}

export interface PlatformMessageGetResult {
  readonly message: PlatformMessageRecord
}

export interface PlatformWorkingMessage {
  readonly binding: ConversationBinding
  readonly text: string
}

export interface PlatformPublication {
  readonly binding: ConversationBinding
  readonly text: string
}

export interface PlatformConversationTitle {
  readonly binding: ConversationBinding
  readonly title: string
}

export interface PlatformAgentActivity {
  readonly binding: ConversationBinding
  readonly taskId: string
  readonly active: boolean
  /** Delegated task text; an opted-in platform may derive a sanitized public label. */
  readonly task?: string
}

export interface PlatformIdentity {
  readonly connectionId: ConversationBinding['connectionId']
  readonly kind: ConversationBinding['platform']
}

export interface PlatformMessaging<PlatformError> {
  readonly publish: (publication: PlatformPublication) => Effect.Effect<void, PlatformError>
  readonly acknowledge: (target: PlatformMessageTarget) => Effect.Effect<void, PlatformError>
  readonly withTyping: <A, E, R>(
    binding: ConversationBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PlatformError, R>
}

export interface PlatformAdapter<PlatformError>
  extends PlatformIdentity, PlatformMessaging<PlatformError> {}

export interface PlatformWorkingMessageCapability<PlatformError> {
  readonly workingMessages: {
    readonly begin: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
    readonly update: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
    readonly finalize: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
    readonly discard: (binding: ConversationBinding) => Effect.Effect<void, PlatformError>
  }
}

export interface PlatformConversationTitleCapability<PlatformError> {
  readonly conversationTitle: {
    readonly set: (title: PlatformConversationTitle) => Effect.Effect<void, PlatformError>
  }
}

export interface PlatformAgentActivityCapability<PlatformError> {
  readonly agentActivity: {
    readonly set: (activity: PlatformAgentActivity) => Effect.Effect<void, PlatformError>
  }
}

export interface PlatformMessageSearchCapability<PlatformError> {
  readonly messageSearch: {
    readonly search: (
      query: PlatformMessageQuery,
    ) => Effect.Effect<PlatformMessageSearchResult, PlatformError | PlatformTargetNotFoundError>
  }
}

export interface PlatformMessageGetCapability<PlatformError> {
  readonly messageGet: {
    readonly get: (
      query: PlatformMessageGetQuery,
    ) => Effect.Effect<PlatformMessageGetResult, PlatformError | PlatformMessageNotFoundError>
  }
}

export interface PlatformMessagePostCapability<PlatformError> {
  readonly messagePost: {
    readonly post: (
      query: PlatformMessagePostQuery,
    ) => Effect.Effect<PlatformMessagePostResult, PlatformError | PlatformTargetNotFoundError>
  }
}

export interface PlatformMembersCapability<PlatformError> {
  readonly members: {
    readonly list: (
      query: PlatformMembersQuery,
    ) => Effect.Effect<
      PlatformMembersResult,
      PlatformError | PlatformTargetNotFoundError | PlatformMembersUnsupportedError
    >
  }
}

export interface PlatformDiscoveryCapability<PlatformError> {
  readonly discovery: {
    readonly discover: (
      query: PlatformDiscoveryQuery,
    ) => Effect.Effect<
      PlatformDiscoveryResult,
      PlatformError | PlatformTargetNotFoundError | PlatformMembersUnsupportedError
    >
  }
}

export type PlatformCapabilities<PlatformError> = PlatformWorkingMessageCapability<PlatformError> &
  PlatformConversationTitleCapability<PlatformError> &
  PlatformAgentActivityCapability<PlatformError> &
  PlatformMessageSearchCapability<PlatformError> &
  PlatformMessageGetCapability<PlatformError> &
  PlatformMessagePostCapability<PlatformError> &
  PlatformMembersCapability<PlatformError> &
  PlatformDiscoveryCapability<PlatformError>

/** A heterogeneous registry accepts any explicit subset of optional capabilities. */
export type PlatformRegistration<PlatformError> = PlatformAdapter<PlatformError> &
  Partial<PlatformCapabilities<PlatformError>>
