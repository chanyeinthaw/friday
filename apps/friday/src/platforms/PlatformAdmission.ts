import * as Effect from 'effect/Effect'

import type { PlatformInput } from './PlatformAdapter.ts'
import type { ChatSdkInboundKind } from './chat-sdk/ChatSdkLifecycle.ts'

/**
 * Why this layer exists: Discord and Slack previously duplicated the same
 * admission orchestration (policy resolve, user check, dedup, binding lookup,
 * invocation decision, logging) in their lifecycle `shouldHandleMessage`
 * gates. This module owns that ordering and mechanics once. Platform hooks own
 * only platform semantics from canonical projected input.
 *
 * The adapter-boundary preflights (`FridayDiscordAdapter`, `FridaySlackAdapter`)
 * remain and stay narrow: they drop unknown/disabled scopes and denied users
 * before upstream Chat SDK state or visible platform side effects (Discord
 * thread creation, Slack Chat state/prompts/status). They never consult Friday
 * persistence and never implement the full invocation decision; this layer is
 * the authoritative gate after projection and before `PlatformIngestion.ingest`.
 * The policy-change race between the adapter preflight and this layer is
 * accepted and out of scope.
 */
export type PlatformAdmissionDropReason =
  | 'unknown-policy'
  | 'unauthorized-user'
  | 'duplicate-message'
  | 'not-invoked'

/** Platform semantics over canonical projected input; shared code never parses raw events. */
export interface PlatformAdmissionHooks<Policy> {
  readonly platform: string
  readonly connectionId: string
  /**
   * Resolves the platform policy from canonical projected input. Returns
   * undefined when the input location is undecodable or the scope admission
   * (`all|allow|deny`) rejects it. Never throws: decode failures drop.
   */
  readonly resolvePolicy: (input: PlatformInput) => Policy | undefined
  /** Evaluates user admission (`all|allow|deny`) against the resolved policy. */
  readonly isUserAdmitted: (input: PlatformInput, policy: Policy) => boolean
  /**
   * Optional duplicate-message check (Slack socket redeliveries). Returns true
   * to drop. Runs after scope/user admission and before the binding lookup,
   * preserving the previous ordering.
   */
  readonly checkDuplicate?: ((input: PlatformInput) => boolean) | undefined
  /**
   * Platform-specific invocation decision from `hasBinding` plus policy/mode.
   * Discord ignores `hasBinding` (mentions/DMs always invoke; subscribed
   * follows `mention-only|all-messages`); Slack invokes on DMs, bound-thread
   * continuation, or direct mentions.
   */
  readonly shouldInvoke: (args: {
    readonly input: PlatformInput
    readonly policy: Policy
    readonly hasBinding: boolean
    readonly kind: ChatSdkInboundKind
  }) => boolean
}

export interface PlatformAdmissionDeps<E, R> {
  readonly hasBinding: (input: PlatformInput) => Effect.Effect<boolean, E, R>
  readonly onAdmit: (input: PlatformInput) => Effect.Effect<void, E, R>
}

/**
 * Authoritative pre-ingestion admission. Runs policy resolve, user admission,
 * duplicate check, binding lookup, and invocation decision in order, logs
 * admit/drop consistently, and calls `onAdmit` (the existing inbound ingestion
 * callback) only when admitted. Returns true when admitted.
 */
export const admitPlatformMessage = Effect.fn('PlatformAdmission.admit')(function* <Policy, E, R>(
  input: PlatformInput,
  kind: ChatSdkInboundKind,
  hooks: PlatformAdmissionHooks<Policy>,
  deps: PlatformAdmissionDeps<E, R>,
) {
  const base = {
    platform: hooks.platform,
    connectionId: hooks.connectionId,
    channelId: String(input.binding.channelId),
    conversationId: String(input.binding.conversationId),
    invocationKind: kind,
  }
  const policy = hooks.resolvePolicy(input)
  if (policy === undefined) {
    yield* Effect.logDebug('platform.message.dropped').pipe(
      Effect.annotateLogs({ ...base, reason: 'unknown-policy' as const }),
    )
    return false
  }
  if (!hooks.isUserAdmitted(input, policy)) {
    yield* Effect.logDebug('platform.message.dropped').pipe(
      Effect.annotateLogs({ ...base, reason: 'unauthorized-user' as const }),
    )
    return false
  }
  if (hooks.checkDuplicate?.(input) === true) {
    yield* Effect.logDebug('platform.message.dropped').pipe(
      Effect.annotateLogs({ ...base, reason: 'duplicate-message' as const }),
    )
    return false
  }
  const hasBinding = yield* deps.hasBinding(input)
  if (!hooks.shouldInvoke({ input, policy, hasBinding, kind })) {
    yield* Effect.logDebug('platform.message.dropped').pipe(
      Effect.annotateLogs({ ...base, reason: 'not-invoked' as const, hasBinding }),
    )
    return false
  }
  yield* Effect.logDebug('platform.message.admitted').pipe(
    Effect.annotateLogs({ ...base, hasBinding }),
  )
  yield* deps.onAdmit(input)
  return true
})
