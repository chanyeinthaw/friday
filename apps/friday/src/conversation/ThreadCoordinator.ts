import type { SteeringActivity, TokenUsage, Turn, TurnId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import type { ThreadPersistenceError } from './ThreadPersistence.ts'
import type { HarnessReloadOutcome, ConversationEvent } from './ConversationEvents.ts'

export type TerminalTurn =
  | {
      readonly status: 'completed'
      readonly turnId: TurnId
      readonly agentMessage: string
      readonly usage: TokenUsage | null
    }
  | {
      readonly status: 'interrupted'
      readonly turnId: TurnId
      readonly agentMessage: string | null
      readonly usage: TokenUsage | null
    }
  | {
      readonly status: 'failed'
      readonly turnId: TurnId
      readonly errorMessage: string
    }

export interface TurnHandle<EventError = never> {
  readonly turnId: TurnId
  readonly awaitTerminal: Effect.Effect<TerminalTurn, EventError | ThreadPersistenceError>
}

export interface ThreadCoordinatorContract<PromptError, EventError> {
  readonly prompt: (
    turn: Turn,
  ) => Effect.Effect<TurnHandle<EventError>, PromptError | ThreadPersistenceError>
  readonly steer: (
    turnId: Turn['id'],
    activity: SteeringActivity,
  ) => Effect.Effect<void, PromptError | ThreadPersistenceError>
  readonly cancel: (turnId: TurnId) => Effect.Effect<void, PromptError>
  readonly reload: () => Effect.Effect<HarnessReloadOutcome>
  readonly onEvent: (
    listener: (event: ConversationEvent) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>
}
