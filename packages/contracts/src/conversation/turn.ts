import * as Schema from 'effect/Schema'

import { Activity } from './activity.ts'
import { HarnessTurnId } from './harness.ts'
import { ThreadId, TurnId } from './ids.ts'
import { InputMessage } from './message.ts'
import { ModelSelection, ThinkingLevel } from './model.ts'
import { IsoDateTime, NonNegativeInt, PositiveInt } from './scalar.ts'

export const TurnStatus = Schema.Literals([
  'pending',
  'running',
  'completed',
  'interrupted',
  'failed',
])
export type TurnStatus = typeof TurnStatus.Type

export const TokenUsage = Schema.Struct({
  inputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: Schema.optionalKey(NonNegativeInt),
  reasoningTokens: Schema.optionalKey(NonNegativeInt),
  totalTokens: Schema.optionalKey(NonNegativeInt),
})
export type TokenUsage = typeof TokenUsage.Type

export const Turn = Schema.Struct({
  id: TurnId,
  threadId: ThreadId,
  sequence: PositiveInt,
  input: InputMessage,
  agentMessage: Schema.NullOr(Schema.String),
  activities: Schema.Array(Activity),
  model: ModelSelection,
  thinkingLevel: ThinkingLevel,
  harnessTurnId: Schema.NullOr(HarnessTurnId),
  status: TurnStatus,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  errorMessage: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(TokenUsage),
})
export type Turn = typeof Turn.Type
