import type { ExternalBinding, InputMessage } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'

export interface ExternalInboundMessage {
  readonly binding: ExternalBinding
  readonly message: InputMessage
}

export interface ExternalPublication {
  readonly binding: ExternalBinding
  readonly text: string
}

export interface ExternalPlatformContract<PublicationError> {
  readonly publish: (publication: ExternalPublication) => Effect.Effect<void, PublicationError>
}
