import type {
  ConversationBinding,
  ContextMessage,
  InputMessage,
  PlatformMessageId,
} from '@friday/contracts/conversation'
import type * as Effect from 'effect/Effect'

export interface PlatformInput {
  readonly binding: ConversationBinding
  readonly message: InputMessage
  readonly initialContext?: ReadonlyArray<ContextMessage>
}

export type PlatformMessageScope = 'thread' | 'channel'

export interface PlatformMessageRecord {
  readonly id: PlatformMessageId
  readonly author: ContextMessage['author']
  readonly text: string
  readonly sentAt: string | null
  readonly replyToMessageId: PlatformMessageId | null
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
  /** Raw delegated task text; platforms derive their own concise public labels. */
  readonly task?: string
}

export interface PlatformAdapter<PlatformError> {
  readonly connectionId: ConversationBinding['connectionId']
  readonly kind: ConversationBinding['platform']
  readonly publish: (publication: PlatformPublication) => Effect.Effect<void, PlatformError>
  readonly acknowledge: (target: PlatformMessageTarget) => Effect.Effect<void, PlatformError>
  readonly beginWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
  readonly updateWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
  readonly finalizeWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
  readonly discardWorking: (binding: ConversationBinding) => Effect.Effect<void, PlatformError>
  readonly setConversationTitle: (
    title: PlatformConversationTitle,
  ) => Effect.Effect<void, PlatformError>
  readonly setAgentActivity: (activity: PlatformAgentActivity) => Effect.Effect<void, PlatformError>
  readonly searchMessages: (
    query: PlatformMessageQuery,
  ) => Effect.Effect<PlatformMessageSearchResult, PlatformError>
  readonly withTyping: <A, E, R>(
    binding: ConversationBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PlatformError, R>
}
