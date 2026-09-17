import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type {
  PlatformAgentActivity,
  PlatformConversationTitle,
  PlatformMessageQuery,
  PlatformMessageSearchResult,
  PlatformMessageTarget,
  PlatformPublication,
  PlatformRegistration,
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

const PlatformCapability = Schema.Literals([
  'working-messages',
  'conversation-title',
  'agent-activity',
  'message-search',
])
export type PlatformCapability = typeof PlatformCapability.Type

export class PlatformCapabilityUnavailableError extends Schema.Error<PlatformCapabilityUnavailableError>(
  'PlatformCapabilityUnavailableError',
)({
  _tag: Schema.tag('PlatformCapabilityUnavailableError'),
  kind: Schema.String,
  capability: PlatformCapability,
}) {}

const isPlatformOperationError = Schema.is(PlatformOperationError)
type RegistryError =
  | PlatformNotFoundError
  | PlatformOperationError
  | PlatformCapabilityUnavailableError

export type RegisteredPlatform = PlatformRegistration<PlatformOperationError>

export interface PlatformRegistryContract {
  readonly register: <E>(
    platform: PlatformRegistration<E>,
  ) => Effect.Effect<void, never, Scope.Scope>
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
    const invokeCapability = <A>(
      binding: ConversationBinding,
      capability: PlatformCapability,
      operation: (
        platform: RegisteredPlatform,
      ) => Effect.Effect<A, PlatformOperationError> | undefined,
    ): Effect.Effect<A, RegistryError> =>
      invoke(
        binding,
        (
          platform,
        ): Effect.Effect<A, PlatformOperationError | PlatformCapabilityUnavailableError> => {
          const effect = operation(platform)
          return effect === undefined
            ? Effect.fail(
                new PlatformCapabilityUnavailableError({ kind: platform.kind, capability }),
              )
            : effect
        },
      )

    return PlatformRegistry.of({
      register: <E>(platform: PlatformRegistration<E>) => {
        const wrap = <A>(effect: Effect.Effect<A, E>) =>
          effect.pipe(Effect.mapError((cause) => operationError(platform.kind, cause)))
        const workingMessages = platform.workingMessages
        const conversationTitle = platform.conversationTitle
        const agentActivity = platform.agentActivity
        const messageSearch = platform.messageSearch
        const registered: RegisteredPlatform = {
          connectionId: platform.connectionId,
          kind: platform.kind,
          publish: (publication) => wrap(platform.publish(publication)),
          acknowledge: (target) => wrap(platform.acknowledge(target)),
          withTyping: (binding, effect) =>
            platform
              .withTyping(binding, effect)
              .pipe(
                Effect.mapError((cause) =>
                  isPlatformOperationError(cause) ? cause : operationError(platform.kind, cause),
                ),
              ),
        }
        if (workingMessages !== undefined) {
          Object.assign(registered, {
            workingMessages: {
              begin: (message: PlatformWorkingMessage) => wrap(workingMessages.begin(message)),
              update: (message: PlatformWorkingMessage) => wrap(workingMessages.update(message)),
              finalize: (message: PlatformWorkingMessage) =>
                wrap(workingMessages.finalize(message)),
              discard: (binding: ConversationBinding) => wrap(workingMessages.discard(binding)),
            },
          })
        }
        if (conversationTitle !== undefined) {
          Object.assign(registered, {
            conversationTitle: {
              set: (title: PlatformConversationTitle) => wrap(conversationTitle.set(title)),
            },
          })
        }
        if (agentActivity !== undefined) {
          Object.assign(registered, {
            agentActivity: {
              set: (activity: PlatformAgentActivity) => wrap(agentActivity.set(activity)),
            },
          })
        }
        if (messageSearch !== undefined) {
          Object.assign(registered, {
            messageSearch: {
              search: (query: PlatformMessageQuery) => wrap(messageSearch.search(query)),
            },
          })
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
        invokeCapability(message.binding, 'working-messages', (platform) =>
          platform.workingMessages?.begin(message),
        ),
      updateWorking: (message) =>
        invokeCapability(message.binding, 'working-messages', (platform) =>
          platform.workingMessages?.update(message),
        ),
      finalizeWorking: (message) =>
        invokeCapability(message.binding, 'working-messages', (platform) =>
          platform.workingMessages?.finalize(message),
        ),
      discardWorking: (binding) =>
        invokeCapability(binding, 'working-messages', (platform) =>
          platform.workingMessages?.discard(binding),
        ),
      setConversationTitle: (title) =>
        invokeCapability(title.binding, 'conversation-title', (platform) =>
          platform.conversationTitle?.set(title),
        ),
      setAgentActivity: (activity) =>
        invokeCapability(activity.binding, 'agent-activity', (platform) =>
          platform.agentActivity?.set(activity),
        ),
      searchMessages: (query) =>
        invokeCapability(query.binding, 'message-search', (platform) =>
          platform.messageSearch?.search(query),
        ),
      withTyping: (binding, effect) =>
        invoke(binding, (platform) => platform.withTyping(binding, effect)),
    })
  }),
)
