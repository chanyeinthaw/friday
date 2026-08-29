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
import type * as Stream from 'effect/Stream'

export type PromptMode = 'steer' | 'turn'

export interface PromptRequest {
  readonly turnId: TurnId
  readonly message: InputMessage
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

export interface ThreadRuntime<PromptError = never, EventError = never> {
  readonly threadId: ThreadId
  readonly harnessSession: HarnessSession
  readonly prompt: (request: PromptRequest) => Effect.Effect<void, PromptError>
  readonly cancel: (turnId: TurnId) => Effect.Effect<void, PromptError>
  readonly events: Stream.Stream<ThreadRuntimeEvent, EventError>
}

export interface SteeringRequest {
  readonly turnId: TurnId
  readonly activity: SteeringActivity
}
