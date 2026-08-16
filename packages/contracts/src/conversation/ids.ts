import * as Schema from 'effect/Schema'

const makeId = <Brand extends string>(brand: Brand) =>
  Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()), Schema.brand(brand))

export const ThreadId = makeId('ThreadId')
export type ThreadId = typeof ThreadId.Type

export const TurnId = makeId('TurnId')
export type TurnId = typeof TurnId.Type

export const ActivityId = makeId('ActivityId')
export type ActivityId = typeof ActivityId.Type

export const AttachmentId = makeId('AttachmentId')
export type AttachmentId = typeof AttachmentId.Type

export const ToolCallId = makeId('ToolCallId')
export type ToolCallId = typeof ToolCallId.Type
