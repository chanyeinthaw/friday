import * as Schema from 'effect/Schema'

import { ExternalBinding } from './external.ts'
import { HarnessId, HarnessSession } from './harness.ts'
import { ThreadId, TurnId } from './ids.ts'
import { ModelSelection, ThinkingLevel } from './model.ts'
import { IsoDateTime } from './scalar.ts'

export const WorkingDirectory = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Schema.brand('WorkingDirectory'),
)
export type WorkingDirectory = typeof WorkingDirectory.Type

export const ThreadAudience = Schema.Literals(['user', 'agent'])
export type ThreadAudience = typeof ThreadAudience.Type

export const ThreadStatus = Schema.Literals(['active', 'closed'])
export type ThreadStatus = typeof ThreadStatus.Type

export const ParentReference = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
})
export type ParentReference = typeof ParentReference.Type

const ThreadFields = {
  id: ThreadId,
  harness: HarnessId,
  harnessSession: Schema.NullOr(HarnessSession),
  workingDirectory: WorkingDirectory,
  model: ModelSelection,
  thinkingLevel: ThinkingLevel,
  status: ThreadStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
} as const

export const ChannelThread = Schema.Struct({
  ...ThreadFields,
  audience: Schema.Literal('user'),
  parent: Schema.Null,
  externalBinding: ExternalBinding,
})
export type ChannelThread = typeof ChannelThread.Type

export const AgentThread = Schema.Struct({
  ...ThreadFields,
  audience: Schema.Literal('agent'),
  parent: ParentReference,
  externalBinding: Schema.Null,
})
export type AgentThread = typeof AgentThread.Type

export const Thread = Schema.Union([ChannelThread, AgentThread])
export type Thread = typeof Thread.Type
