import type {
  Activity,
  HarnessSession,
  HarnessTurnId,
  InputMessage,
  IsoDateTime,
  SteeringActivity,
  ThreadId,
  TokenUsage,
  TurnId,
} from '@friday/contracts/conversation'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type * as Stream from 'effect/Stream'

export type PromptMode = 'steer' | 'turn'

/** Trusted authorization derived from the current platform input, never model text. */
export type CurrentTurnAuthorization =
  | { readonly externalUpdateRequests: 'allowed' }
  | { readonly externalUpdateRequests: 'denied' }

export const externalUpdatesAllowed: CurrentTurnAuthorization = {
  externalUpdateRequests: 'allowed',
}
export const externalUpdatesDenied: CurrentTurnAuthorization = {
  externalUpdateRequests: 'denied',
}

export interface PromptRequest {
  readonly turnId: TurnId
  readonly message: InputMessage
  readonly authorization?: CurrentTurnAuthorization
  readonly mode?: PromptMode
}

export type ThreadRuntimeEvent =
  | {
      readonly type: 'turn-started'
      readonly turnId: TurnId
      readonly harnessTurnId: HarnessTurnId | null
      readonly startedAt: IsoDateTime
    }
  | {
      readonly type: 'activity-started'
      readonly turnId: TurnId
      readonly activity: Activity
    }
  | {
      readonly type: 'activity-updated'
      readonly turnId: TurnId
      readonly activity: Activity
    }
  | {
      readonly type: 'activity-completed'
      readonly turnId: TurnId
      readonly activity: Activity
    }
  | {
      readonly type: 'turn-completed'
      readonly turnId: TurnId
      readonly agentMessage: string
      readonly usage: TokenUsage | null
      readonly completedAt: IsoDateTime
    }
  | {
      readonly type: 'turn-interrupted'
      readonly turnId: TurnId
      readonly agentMessage: string | null
      readonly usage: TokenUsage | null
      readonly completedAt: IsoDateTime
    }
  | {
      readonly type: 'turn-failed'
      readonly turnId: TurnId
      readonly errorMessage: string
      readonly completedAt: IsoDateTime
    }

/**
 * Structured result of a harness reload against one live runtime. Reloads
 * refresh the system prompt, harness extensions, and settings in place while
 * preserving the conversation; refusals (busy, absent runtime) and failures never throw
 * across the transport boundary.
 */
export const HarnessReloadOutcome = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals(['busy', 'no-runtime', 'unknown-thread', 'reload-failed']),
    detail: Schema.String,
  }),
])
export type HarnessReloadOutcome = typeof HarnessReloadOutcome.Type

export const harnessReloadSucceeded = (): HarnessReloadOutcome => ({ ok: true })

export const harnessReloadRefused = (
  reason: Exclude<Extract<HarnessReloadOutcome, { ok: false }>['reason'], 'reload-failed'>,
  detail: string,
): HarnessReloadOutcome => ({ ok: false, reason, detail })

export const harnessReloadFailed = (detail: string): HarnessReloadOutcome => ({
  ok: false,
  reason: 'reload-failed',
  detail,
})

/** Human-readable one-line summary shared by the Discord reply. */
export const formatHarnessReloadOutcome = (outcome: HarnessReloadOutcome): string =>
  outcome.ok
    ? 'Harness reloaded (system prompt, extensions, and settings refreshed; conversation preserved).'
    : outcome.reason === 'reload-failed'
      ? `Harness reload failed: ${outcome.detail}`
      : `Harness reload refused (${outcome.reason}): ${outcome.detail}`

export interface ThreadRuntime<PromptError = never, EventError = never> {
  readonly threadId: ThreadId
  readonly harnessSession: HarnessSession
  readonly prompt: (request: PromptRequest) => Effect.Effect<void, PromptError>
  readonly cancel: (turnId: TurnId) => Effect.Effect<void, PromptError>
  /** Reloads the harness session in place; never fails, reports an outcome. */
  readonly reload: () => Effect.Effect<HarnessReloadOutcome>
  readonly events: Stream.Stream<ThreadRuntimeEvent, EventError>
}

export interface SteeringRequest {
  readonly turnId: TurnId
  readonly activity: SteeringActivity
}
