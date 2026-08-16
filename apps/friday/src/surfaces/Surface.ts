import type { ExternalBinding, InputMessage } from '@friday/contracts/conversation'
import type * as Effect from 'effect/Effect'

export interface SurfaceInput {
  readonly binding: ExternalBinding
  readonly message: InputMessage
}

export interface SurfacePublication {
  readonly binding: ExternalBinding
  readonly text: string
}

export interface SurfaceContract<SurfaceError> {
  readonly kind: ExternalBinding['platform']
  readonly publish: (publication: SurfacePublication) => Effect.Effect<void, SurfaceError>
  readonly withTyping: <A, E, R>(
    binding: ExternalBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SurfaceError, R>
}
