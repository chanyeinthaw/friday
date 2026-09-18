import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import {
  PlatformMembersUnsupportedError,
  PlatformMessageNotFoundError,
  PlatformTargetNotFoundError,
} from './PlatformAdapter.ts'
import type {
  PlatformAgentActivity,
  PlatformConversationTitle,
  PlatformDiscoveryQuery,
  PlatformDiscoveryResult,
  PlatformMembersQuery,
  PlatformMembersResult,
  PlatformMessageGetQuery,
  PlatformMessageGetResult,
  PlatformMessagePostQuery,
  PlatformMessagePostResult,
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
  'message-get',
  'message-post',
  'message-members',
  'platform-discovery',
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
const isMessageNotFound = Schema.is(PlatformMessageNotFoundError)
const isTargetNotFound = Schema.is(PlatformTargetNotFoundError)
const isMembersUnsupported = Schema.is(PlatformMembersUnsupportedError)
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
  ) => Effect.Effect<PlatformMessageSearchResult, RegistryError | PlatformTargetNotFoundError>
  readonly getMessage: (
    query: PlatformMessageGetQuery,
  ) => Effect.Effect<PlatformMessageGetResult, RegistryError | PlatformMessageNotFoundError>
  readonly postMessage: (
    query: PlatformMessagePostQuery,
  ) => Effect.Effect<PlatformMessagePostResult, RegistryError | PlatformTargetNotFoundError>
  readonly listMembers: (
    query: PlatformMembersQuery,
  ) => Effect.Effect<
    PlatformMembersResult,
    RegistryError | PlatformTargetNotFoundError | PlatformMembersUnsupportedError
  >
  readonly discoverPlatforms: (
    query: PlatformDiscoveryQuery,
  ) => Effect.Effect<
    PlatformDiscoveryResult,
    RegistryError | PlatformTargetNotFoundError | PlatformMembersUnsupportedError
  >
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
    const invokeCapability = <A, E>(
      binding: ConversationBinding,
      capability: PlatformCapability,
      operation: (platform: RegisteredPlatform) => Effect.Effect<A, E> | undefined,
    ): Effect.Effect<A, E | PlatformNotFoundError | PlatformCapabilityUnavailableError> =>
      invoke(binding, (platform): Effect.Effect<A, E | PlatformCapabilityUnavailableError> => {
        const effect = operation(platform)
        return effect === undefined
          ? Effect.fail(new PlatformCapabilityUnavailableError({ kind: platform.kind, capability }))
          : effect
      })

    return PlatformRegistry.of({
      register: <E>(platform: PlatformRegistration<E>) => {
        const wrap = <A>(effect: Effect.Effect<A, E>) =>
          effect.pipe(Effect.mapError((cause) => operationError(platform.kind, cause)))
        // Single-message retrieval preserves its generic not-found across the
        // boundary; every other platform failure still becomes an operation error.
        const wrapGet = <A>(effect: Effect.Effect<A, E | PlatformMessageNotFoundError>) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isMessageNotFound(cause) ? cause : operationError(platform.kind, cause),
            ),
          )
        // Target admission preserves its generic not-found across the
        // boundary; it never exposes whether a channel exists. Honest
        // unsupported-scope failures preserve their typed detail the same way.
        const wrapTarget = <A>(effect: Effect.Effect<A, E | PlatformTargetNotFoundError>) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isTargetNotFound(cause) ? cause : operationError(platform.kind, cause),
            ),
          )
        const wrapScoped = <A>(
          effect: Effect.Effect<
            A,
            E | PlatformTargetNotFoundError | PlatformMembersUnsupportedError
          >,
        ) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isTargetNotFound(cause) || isMembersUnsupported(cause)
                ? cause
                : operationError(platform.kind, cause),
            ),
          )
        const workingMessages = platform.workingMessages
        const conversationTitle = platform.conversationTitle
        const agentActivity = platform.agentActivity
        const messageSearch = platform.messageSearch
        const messageGet = platform.messageGet
        const messagePost = platform.messagePost
        const members = platform.members
        const discovery = platform.discovery
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
              search: (query: PlatformMessageQuery) => wrapTarget(messageSearch.search(query)),
            },
          })
        }
        if (messagePost !== undefined) {
          Object.assign(registered, {
            messagePost: {
              post: (query: PlatformMessagePostQuery) => wrapTarget(messagePost.post(query)),
            },
          })
        }
        if (messageGet !== undefined) {
          Object.assign(registered, {
            messageGet: {
              get: (query: PlatformMessageGetQuery) => wrapGet(messageGet.get(query)),
            },
          })
        }
        if (members !== undefined) {
          Object.assign(registered, {
            members: {
              list: (query: PlatformMembersQuery) => wrapScoped(members.list(query)),
            },
          })
        }
        if (discovery !== undefined) {
          Object.assign(registered, {
            discovery: {
              discover: (query: PlatformDiscoveryQuery) => wrapScoped(discovery.discover(query)),
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
      postMessage: (query) =>
        invokeCapability(query.binding, 'message-post', (platform) =>
          platform.messagePost?.post(query),
        ),
      listMembers: (query) =>
        invokeCapability(query.binding, 'message-members', (platform) =>
          platform.members?.list(query),
        ),
      discoverPlatforms: (query) =>
        invokeCapability(query.binding, 'platform-discovery', (platform) =>
          platform.discovery?.discover(query),
        ),
      getMessage: (query) =>
        invokeCapability(query.binding, 'message-get', (platform) =>
          platform.messageGet?.get(query),
        ),
      withTyping: (binding, effect) =>
        invoke(binding, (platform) => platform.withTyping(binding, effect)),
    })
  }),
)
