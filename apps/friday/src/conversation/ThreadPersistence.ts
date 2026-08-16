import type {
  Activity,
  PlatformKind,
  PlatformConversationId,
  HarnessSession,
  HarnessTurnId,
  IsoDateTime,
  Thread,
  ThreadId,
  TokenUsage,
  Turn,
  TurnId,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'

import type { PersistenceError } from '../persistence/Errors.ts'

export type ThreadPersistenceError = PersistenceError

export interface PlatformThreadLookup {
  readonly platform: PlatformKind
  readonly conversationId: PlatformConversationId
}

export interface ThreadHarnessSessionUpdate {
  readonly threadId: ThreadId
  readonly harnessSession: HarnessSession
}

export interface TurnStartedUpdate {
  readonly turnId: TurnId
  readonly harnessTurnId: HarnessTurnId | null
  readonly startedAt: IsoDateTime
}

export interface TurnCompletedUpdate {
  readonly turnId: TurnId
  readonly agentMessage: string
  readonly usage: TokenUsage | null
  readonly completedAt: IsoDateTime
}

export interface TurnInterruptedUpdate {
  readonly turnId: TurnId
  readonly agentMessage: string | null
  readonly usage: TokenUsage | null
  readonly completedAt: IsoDateTime
}

export interface TurnFailedUpdate {
  readonly turnId: TurnId
  readonly errorMessage: string
  readonly completedAt: IsoDateTime
}

export interface ThreadPersistenceContract {
  readonly createThread: (thread: Thread) => Effect.Effect<void, ThreadPersistenceError>
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<Thread>, ThreadPersistenceError>
  readonly findPlatformThread: (
    lookup: PlatformThreadLookup,
  ) => Effect.Effect<Option.Option<Thread>, ThreadPersistenceError>
  readonly setThreadHarnessSession: (
    update: ThreadHarnessSessionUpdate,
  ) => Effect.Effect<void, ThreadPersistenceError>
  readonly createTurn: (turn: Turn) => Effect.Effect<void, ThreadPersistenceError>
  readonly getTurn: (turnId: TurnId) => Effect.Effect<Option.Option<Turn>, ThreadPersistenceError>
  readonly getLatestTurn: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<Turn>, ThreadPersistenceError>
  readonly startTurn: (update: TurnStartedUpdate) => Effect.Effect<void, ThreadPersistenceError>
  readonly putActivitySnapshot: (
    turnId: TurnId,
    activity: Activity,
  ) => Effect.Effect<void, ThreadPersistenceError>
  readonly getActivity: (
    activityId: Activity['id'],
  ) => Effect.Effect<Option.Option<Activity>, ThreadPersistenceError>
  readonly completeTurn: (
    update: TurnCompletedUpdate,
  ) => Effect.Effect<void, ThreadPersistenceError>
  readonly interruptTurn: (
    update: TurnInterruptedUpdate,
  ) => Effect.Effect<void, ThreadPersistenceError>
  readonly failTurn: (update: TurnFailedUpdate) => Effect.Effect<void, ThreadPersistenceError>
}

export class ThreadPersistence extends Context.Service<
  ThreadPersistence,
  ThreadPersistenceContract
>()('friday/conversation/ThreadPersistence') {}
