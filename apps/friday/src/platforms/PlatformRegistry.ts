import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { PlatformAdapter, PlatformPublication } from './PlatformAdapter.ts'

export class PlatformNotFoundError extends Schema.Error<PlatformNotFoundError>(
  'PlatformNotFoundError',
)({
  _tag: Schema.tag('PlatformNotFoundError'),
  kind: Schema.String,
}) {}

export class PlatformOperationError extends Schema.Error<PlatformOperationError>(
  'PlatformOperationError',
)({
  _tag: Schema.tag('PlatformOperationError'),
  kind: Schema.String,
  cause: Schema.Defect(),
}) {}

const isPlatformNotFoundError = Schema.is(PlatformNotFoundError)
const isPlatformOperationError = Schema.is(PlatformOperationError)

export interface RegisteredPlatform {
  readonly kind: ConversationBinding['platform']
  readonly publish: (
    publication: PlatformPublication,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly withTyping: <A, E, R>(
    binding: ConversationBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PlatformOperationError, R>
}

export interface PlatformRegistryContract {
  readonly register: <E>(platform: PlatformAdapter<E>) => Effect.Effect<void, never, Scope.Scope>
  readonly publish: (
    publication: PlatformPublication,
  ) => Effect.Effect<void, PlatformNotFoundError | PlatformOperationError>
  readonly withTyping: <A, E, R>(
    binding: ConversationBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PlatformNotFoundError | PlatformOperationError, R>
}

export class PlatformRegistry extends Context.Service<PlatformRegistry, PlatformRegistryContract>()(
  'friday/platforms/PlatformRegistry',
) {}

export const PlatformRegistryLive = Layer.effect(
  PlatformRegistry,
  Effect.sync(() => {
    const platforms = new Map<ConversationBinding['platform'], RegisteredPlatform>()

    const find = (
      kind: ConversationBinding['platform'],
    ): Effect.Effect<RegisteredPlatform, PlatformNotFoundError> => {
      const platform = platforms.get(kind)
      return platform ? Effect.succeed(platform) : Effect.fail(new PlatformNotFoundError({ kind }))
    }

    return PlatformRegistry.of({
      register: <E>(platform: PlatformAdapter<E>) => {
        const registered: RegisteredPlatform = {
          kind: platform.kind,
          publish: (publication) =>
            platform
              .publish(publication)
              .pipe(
                Effect.mapError(
                  (cause) => new PlatformOperationError({ kind: platform.kind, cause }),
                ),
              ),
          withTyping: (binding, effect) =>
            platform
              .withTyping(binding, effect)
              .pipe(
                Effect.mapError((cause) =>
                  isPlatformOperationError(cause)
                    ? cause
                    : new PlatformOperationError({ kind: platform.kind, cause }),
                ),
              ),
        }
        return Effect.acquireRelease(
          Effect.sync(() => {
            platforms.set(platform.kind, registered)
          }),
          () =>
            Effect.sync(() => {
              if (platforms.get(platform.kind) === registered) platforms.delete(platform.kind)
            }),
        )
      },
      publish: (publication) =>
        find(publication.binding.platform).pipe(
          Effect.flatMap((platform) => platform.publish(publication)),
          Effect.mapError((cause) =>
            isPlatformNotFoundError(cause)
              ? cause
              : new PlatformOperationError({
                  kind: publication.binding.platform,
                  cause,
                }),
          ),
        ),
      withTyping: (binding, effect) =>
        find(binding.platform).pipe(
          Effect.flatMap((platform) => platform.withTyping(binding, effect)),
          Effect.mapError((cause) =>
            isPlatformNotFoundError(cause)
              ? cause
              : new PlatformOperationError({ kind: binding.platform, cause }),
          ),
        ),
    })
  }),
)
