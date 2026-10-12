import * as Schema from 'effect/Schema'

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())

export const ThreadId = Id.pipe(Schema.brand('ThreadId'))
export type ThreadId = typeof ThreadId.Type

export const TurnId = Id.pipe(Schema.brand('TurnId'))
export type TurnId = typeof TurnId.Type

export const ActivityId = Id.pipe(Schema.brand('ActivityId'))
export type ActivityId = typeof ActivityId.Type

export const AttachmentId = Id.pipe(Schema.brand('AttachmentId'))
export type AttachmentId = typeof AttachmentId.Type

export const ToolCallId = Id.pipe(Schema.brand('ToolCallId'))
export type ToolCallId = typeof ToolCallId.Type
