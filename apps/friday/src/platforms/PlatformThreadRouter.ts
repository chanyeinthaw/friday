import type { ContextMessage } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

/** Conservative keep decision: the message stays in the parent channel. */
export const KeepChannelDecision = Schema.Struct({
  decision: Schema.Literal('keep-channel'),
  reason: Schema.Literal('channel-appropriate'),
})
export type KeepChannelDecision = typeof KeepChannelDecision.Type

/** Routing decision: move the message to a new native Discord thread. */
export const CreateThreadDecision = Schema.Struct({
  decision: Schema.Literal('create-thread'),
  reason: Schema.Literals(['explicit-request', 'thread-beneficial']),
})
export type CreateThreadDecision = typeof CreateThreadDecision.Type

/**
 * Adaptive thread routing decision. The union enforces the conservative
 * contract: `keep-channel` only pairs with `channel-appropriate`, while
 * `create-thread` requires an explicit request or clearly beneficial threading.
 */
export const ThreadRouteDecision = Schema.Union([KeepChannelDecision, CreateThreadDecision])
export type ThreadRouteDecision = typeof ThreadRouteDecision.Type

export const decodeThreadRouteDecision = Schema.decodeUnknownEffect(ThreadRouteDecision)

export class PlatformThreadRouterError extends Schema.Error<PlatformThreadRouterError>(
  'PlatformThreadRouterError',
)({
  _tag: Schema.tag('PlatformThreadRouterError'),
  operation: Schema.Literal('thread-route'),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ThreadRouteDecideInput {
  readonly text: string
  readonly context: ReadonlyArray<ContextMessage>
}

export interface PlatformThreadRouterContract {
  /**
   * Decides whether a top-level reply-in-channel message should stay in the
   * channel or move to a new native thread. Reads the current utility model
   * on every call so configuration reloads apply without a restart. Fails
   * with `PlatformThreadRouterError` on model, auth, timeout, or validation
   * failures; callers log and continue in the parent channel.
   */
  readonly decide: (
    input: ThreadRouteDecideInput,
  ) => Effect.Effect<ThreadRouteDecision, PlatformThreadRouterError>
}

export class PlatformThreadRouter extends Context.Service<
  PlatformThreadRouter,
  PlatformThreadRouterContract
>()('friday/platforms/PlatformThreadRouter') {}
