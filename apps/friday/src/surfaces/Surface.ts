import type { SurfaceBinding, InputMessage } from '@friday/contracts/conversation'
import type * as Effect from 'effect/Effect'

export interface SurfaceInput {
  readonly binding: SurfaceBinding
  readonly message: InputMessage
}

export interface SurfacePublication {
  readonly binding: SurfaceBinding
  readonly text: string
}

export interface SurfaceContract<SurfaceError> {
  readonly kind: SurfaceBinding['surface']
  readonly publish: (publication: SurfacePublication) => Effect.Effect<void, SurfaceError>
  readonly withTyping: <A, E, R>(
    binding: SurfaceBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SurfaceError, R>
}
