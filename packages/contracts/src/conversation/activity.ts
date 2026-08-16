import * as Schema from 'effect/Schema'

import { ActivityId, ToolCallId } from './ids.ts'
import { InputMessage } from './message.ts'
import { IsoDateTime, NonNegativeInt } from './scalar.ts'

export const ActivityBase = Schema.Struct({
  id: ActivityId,
  sequence: NonNegativeInt,
  createdAt: IsoDateTime,
})

export const SteeringActivity = Schema.Struct({
  ...ActivityBase.fields,
  type: Schema.Literal('steering'),
  message: InputMessage,
})
export type SteeringActivity = typeof SteeringActivity.Type

export const CommentaryActivity = Schema.Struct({
  ...ActivityBase.fields,
  type: Schema.Literal('commentary'),
  text: Schema.String,
  streaming: Schema.Boolean,
})
export type CommentaryActivity = typeof CommentaryActivity.Type

export const ToolCallActivity = Schema.Struct({
  ...ActivityBase.fields,
  type: Schema.Literal('tool-call'),
  callId: ToolCallId,
  toolName: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  input: Schema.Json,
})
export type ToolCallActivity = typeof ToolCallActivity.Type

export const ToolResultActivity = Schema.Struct({
  ...ActivityBase.fields,
  type: Schema.Literal('tool-result'),
  callId: ToolCallId,
  output: Schema.Json,
  isError: Schema.Boolean,
})
export type ToolResultActivity = typeof ToolResultActivity.Type

export const Activity = Schema.Union([
  SteeringActivity,
  CommentaryActivity,
  ToolCallActivity,
  ToolResultActivity,
])
export type Activity = typeof Activity.Type
