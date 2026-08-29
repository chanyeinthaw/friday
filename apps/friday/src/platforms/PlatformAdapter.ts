import type {
  ConversationBinding,
  InputMessage,
  PlatformMessageId,
} from '@friday/contracts/conversation'
import type * as Effect from 'effect/Effect'

export interface PlatformInput {
  readonly binding: ConversationBinding
  readonly message: InputMessage
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

export interface PlatformAdapter<PlatformError> {
  readonly kind: ConversationBinding['platform']
  readonly publish: (publication: PlatformPublication) => Effect.Effect<void, PlatformError>
  readonly acknowledge: (target: PlatformMessageTarget) => Effect.Effect<void, PlatformError>
  readonly beginWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
  readonly updateWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
  readonly finalizeWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, PlatformError>
  readonly withTyping: <A, E, R>(
    binding: ConversationBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PlatformError, R>
}
