import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type {
  PlatformAdapter,
  PlatformAgentActivity,
  PlatformConversationTitle,
  PlatformMessageQuery,
  PlatformMessageSearchResult,
  PlatformMessageTarget,
  PlatformPublication,
  PlatformWorkingMessage,
} from './PlatformAdapter.ts'

export class PlatformNotFoundError extends Schema.Error<PlatformNotFoundError>(
  'PlatformNotFoundError',
)({
  _tag: Schema.tag('PlatformNotFoundError'),
  connectionId: Schema.String,
  kind: Schema.String,
}) {}

export class PlatformOperationError extends Schema.Error<PlatformOperationError>(
  'PlatformOperationError',
)({ _tag: Schema.tag('PlatformOperationError'), kind: Schema.String, cause: Schema.Defect() }) {}

const isPlatformOperationError = Schema.is(PlatformOperationError)
type RegistryError = PlatformNotFoundError | PlatformOperationError

export interface RegisteredPlatform {
  readonly connectionId: ConversationBinding['connectionId']
  readonly kind: ConversationBinding['platform']
  readonly publish: (
    publication: PlatformPublication,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly acknowledge: (
    target: PlatformMessageTarget,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly beginWorking: (
    message: PlatformWorkingMessage,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly updateWorking: (
    message: PlatformWorkingMessage,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly finalizeWorking: (
    message: PlatformWorkingMessage,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly discardWorking: (
    binding: ConversationBinding,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly setConversationTitle: (
    title: PlatformConversationTitle,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly setAgentActivity: (
    activity: PlatformAgentActivity,
  ) => Effect.Effect<void, PlatformOperationError>
  readonly searchMessages: (
    query: PlatformMessageQuery,
  ) => Effect.Effect<PlatformMessageSearchResult, PlatformOperationError>
  readonly withTyping: <A, E, R>(
    binding: ConversationBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PlatformOperationError, R>
}

export interface PlatformRegistryContract {
  readonly register: <E>(platform: PlatformAdapter<E>) => Effect.Effect<void, never, Scope.Scope>
  readonly publish: (publication: PlatformPublication) => Effect.Effect<void, RegistryError>
  readonly acknowledge: (target: PlatformMessageTarget) => Effect.Effect<void, RegistryError>
  readonly beginWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, RegistryError>
  readonly updateWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, RegistryError>
  readonly finalizeWorking: (message: PlatformWorkingMessage) => Effect.Effect<void, RegistryError>
  readonly discardWorking: (binding: ConversationBinding) => Effect.Effect<void, RegistryError>
  readonly setConversationTitle: (
    title: PlatformConversationTitle,
  ) => Effect.Effect<void, RegistryError>
  readonly setAgentActivity: (activity: PlatformAgentActivity) => Effect.Effect<void, RegistryError>
  readonly searchMessages: (
    query: PlatformMessageQuery,
  ) => Effect.Effect<PlatformMessageSearchResult, RegistryError>
  readonly withTyping: <A, E, R>(
    binding: ConversationBinding,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | RegistryError, R>
}

export class PlatformRegistry extends Context.Service<PlatformRegistry, PlatformRegistryContract>()(
  'friday/platforms/PlatformRegistry',
) {}

export const PlatformRegistryLive = Layer.effect(
  PlatformRegistry,
  Effect.sync(() => {
    const platforms = new Map<ConversationBinding['connectionId'], RegisteredPlatform>()
    const find = (binding: ConversationBinding) => {
      const platform = platforms.get(binding.connectionId)
      return platform && platform.kind === binding.platform
        ? Effect.succeed(platform)
        : Effect.fail(
            new PlatformNotFoundError({
              connectionId: binding.connectionId,
              kind: binding.platform,
            }),
          )
    }
    const operationError = (kind: ConversationBinding['platform'], cause: unknown) =>
      new PlatformOperationError({ kind, cause })
    const invoke = <A, E, R>(
      binding: ConversationBinding,
      operation: (platform: RegisteredPlatform) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | PlatformNotFoundError, R> =>
      find(binding).pipe(Effect.flatMap(operation))

    return PlatformRegistry.of({
      register: <E>(platform: PlatformAdapter<E>) => {
        const wrap = <A>(effect: Effect.Effect<A, E>) =>
          effect.pipe(Effect.mapError((cause) => operationError(platform.kind, cause)))
        const registered: RegisteredPlatform = {
          connectionId: platform.connectionId,
          kind: platform.kind,
          publish: (publication) => wrap(platform.publish(publication)),
          acknowledge: (target) => wrap(platform.acknowledge(target)),
          beginWorking: (message) => wrap(platform.beginWorking(message)),
          updateWorking: (message) => wrap(platform.updateWorking(message)),
          finalizeWorking: (message) => wrap(platform.finalizeWorking(message)),
          discardWorking: (binding) => wrap(platform.discardWorking(binding)),
          setConversationTitle: (title) => wrap(platform.setConversationTitle(title)),
          setAgentActivity: (activity) => wrap(platform.setAgentActivity(activity)),
          searchMessages: (query) => wrap(platform.searchMessages(query)),
          withTyping: (binding, effect) =>
            platform
              .withTyping(binding, effect)
              .pipe(
                Effect.mapError((cause) =>
                  isPlatformOperationError(cause) ? cause : operationError(platform.kind, cause),
                ),
              ),
        }
        return Effect.acquireRelease(
          Effect.sync(() => void platforms.set(platform.connectionId, registered)),
          () =>
            Effect.sync(() => {
              if (platforms.get(platform.connectionId) === registered) {
                platforms.delete(platform.connectionId)
              }
            }),
        )
      },
      publish: (publication) =>
        invoke(publication.binding, (platform) => platform.publish(publication)),
      acknowledge: (target) => invoke(target.binding, (platform) => platform.acknowledge(target)),
      beginWorking: (message) =>
        invoke(message.binding, (platform) => platform.beginWorking(message)),
      updateWorking: (message) =>
        invoke(message.binding, (platform) => platform.updateWorking(message)),
      finalizeWorking: (message) =>
        invoke(message.binding, (platform) => platform.finalizeWorking(message)),
      discardWorking: (binding) => invoke(binding, (platform) => platform.discardWorking(binding)),
      setConversationTitle: (title) =>
        invoke(title.binding, (platform) => platform.setConversationTitle(title)),
      setAgentActivity: (activity) =>
        invoke(activity.binding, (platform) => platform.setAgentActivity(activity)),
      searchMessages: (query) =>
        invoke(query.binding, (platform) => platform.searchMessages(query)),
      withTyping: (binding, effect) =>
        invoke(binding, (platform) => platform.withTyping(binding, effect)),
    })
  }),
)
