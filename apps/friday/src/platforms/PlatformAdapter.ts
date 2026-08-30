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
}

export interface PlatformAdapter<PlatformError> {
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
  readonly withTyping: <A, E, R>(
    binding: ConversationBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PlatformError, R>
}
