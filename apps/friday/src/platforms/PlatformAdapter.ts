import type {
  ConversationBinding,
  ContextMessage,
  ImageAttachment,
  InputMessage,
  PlatformMessageId,
} from '@friday/contracts/conversation'
import type * as Effect from 'effect/Effect'
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

export type PlatformMessageScope = 'thread' | 'channel'

/** Reads the normalized history source across the renamed field and its Discord alias. */
export const platformHistorySource = (input: PlatformInput): 'channel' | 'thread' | undefined =>
  input.historySource ?? input.discordHistorySource

export interface PlatformMessageRecord {
  readonly id: PlatformMessageId
  readonly author: ContextMessage['author']
  readonly text: string
  readonly sentAt: string | null
  readonly replyToMessageId: PlatformMessageId | null
  /** Projected Discord attachments (images, HTML, Markdown, plain text). Empty when none. */
  readonly attachments: ReadonlyArray<ImageAttachment>
}

export interface PlatformMessageQuery {
  readonly binding: ConversationBinding
  readonly scope: PlatformMessageScope
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
  readonly scope: PlatformMessageScope
  readonly messageId?: PlatformMessageId | undefined
  readonly messageUrl?: string | undefined
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
    ) => Effect.Effect<PlatformMessageSearchResult, PlatformError>
  }
}

export interface PlatformMessageGetCapability<PlatformError> {
  readonly messageGet: {
    readonly get: (
      query: PlatformMessageGetQuery,
    ) => Effect.Effect<PlatformMessageGetResult, PlatformError | PlatformMessageNotFoundError>
  }
}

export type PlatformCapabilities<PlatformError> = PlatformWorkingMessageCapability<PlatformError> &
  PlatformConversationTitleCapability<PlatformError> &
  PlatformAgentActivityCapability<PlatformError> &
  PlatformMessageSearchCapability<PlatformError> &
  PlatformMessageGetCapability<PlatformError>

/** A heterogeneous registry accepts any explicit subset of optional capabilities. */
export type PlatformRegistration<PlatformError> = PlatformAdapter<PlatformError> &
  Partial<PlatformCapabilities<PlatformError>>
