import type { ExternalBinding } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { SurfaceContract, SurfacePublication } from './Surface.ts'

export class SurfaceNotFoundError extends Schema.Error<SurfaceNotFoundError>(
  'SurfaceNotFoundError',
)({
  _tag: Schema.tag('SurfaceNotFoundError'),
  kind: Schema.String,
}) {}

export class SurfaceOperationError extends Schema.Error<SurfaceOperationError>(
  'SurfaceOperationError',
)({
  _tag: Schema.tag('SurfaceOperationError'),
  kind: Schema.String,
  cause: Schema.Defect(),
}) {}

const isSurfaceNotFoundError = Schema.is(SurfaceNotFoundError)
const isSurfaceOperationError = Schema.is(SurfaceOperationError)

export interface RegisteredSurface {
  readonly kind: ExternalBinding['platform']
  readonly publish: (publication: SurfacePublication) => Effect.Effect<void, SurfaceOperationError>
  readonly withTyping: <A, E, R>(
    binding: ExternalBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SurfaceOperationError, R>
}

export interface SurfacesContract {
  readonly register: <E>(surface: SurfaceContract<E>) => Effect.Effect<void, never, Scope.Scope>
  readonly publish: (
    publication: SurfacePublication,
  ) => Effect.Effect<void, SurfaceNotFoundError | SurfaceOperationError>
  readonly withTyping: <A, E, R>(
    binding: ExternalBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SurfaceNotFoundError | SurfaceOperationError, R>
}

export class Surfaces extends Context.Service<Surfaces, SurfacesContract>()(
  'friday/surfaces/Surfaces',
) {}

export const SurfacesLive = Layer.effect(
  Surfaces,
  Effect.sync(() => {
    const surfaces = new Map<ExternalBinding['platform'], RegisteredSurface>()

    const find = (
      kind: ExternalBinding['platform'],
    ): Effect.Effect<RegisteredSurface, SurfaceNotFoundError> => {
      const surface = surfaces.get(kind)
      return surface ? Effect.succeed(surface) : Effect.fail(new SurfaceNotFoundError({ kind }))
    }

    return Surfaces.of({
      register: <E>(surface: SurfaceContract<E>) => {
        const registered: RegisteredSurface = {
          kind: surface.kind,
          publish: (publication) =>
            surface
              .publish(publication)
              .pipe(
                Effect.mapError(
                  (cause) => new SurfaceOperationError({ kind: surface.kind, cause }),
                ),
              ),
          withTyping: (binding, effect) =>
            surface
              .withTyping(binding, effect)
              .pipe(
                Effect.mapError((cause) =>
                  isSurfaceOperationError(cause)
                    ? cause
                    : new SurfaceOperationError({ kind: surface.kind, cause }),
                ),
              ),
        }
        return Effect.acquireRelease(
          Effect.sync(() => {
            surfaces.set(surface.kind, registered)
          }),
          () =>
            Effect.sync(() => {
              if (surfaces.get(surface.kind) === registered) surfaces.delete(surface.kind)
            }),
        )
      },
      publish: (publication) =>
        find(publication.binding.platform).pipe(
          Effect.flatMap((surface) => surface.publish(publication)),
          Effect.mapError((cause) =>
            isSurfaceNotFoundError(cause)
              ? cause
              : new SurfaceOperationError({
                  kind: publication.binding.platform,
                  cause,
                }),
          ),
        ),
      withTyping: (binding, effect) =>
        find(binding.platform).pipe(
          Effect.flatMap((surface) => surface.withTyping(binding, effect)),
          Effect.mapError((cause) =>
            isSurfaceNotFoundError(cause)
              ? cause
              : new SurfaceOperationError({ kind: binding.platform, cause }),
          ),
        ),
    })
  }),
)
