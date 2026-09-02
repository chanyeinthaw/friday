import * as Schema from 'effect/Schema'

import { ConversationBinding } from './platform.ts'
import { HarnessId, HarnessSession } from './harness.ts'
import { ThreadId, TurnId } from './ids.ts'
import { ModelSelection, SubagentProfileName, ThinkingLevel } from './model.ts'
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

export const ChannelContext = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  description: Schema.String,
})
export type ChannelContext = typeof ChannelContext.Type

export const AgentRole = Schema.Literals(['subagent', 'bootstrap'])
export type AgentRole = typeof AgentRole.Type

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

export const LinkedDiscordSource = Schema.Struct({
  linkId: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  sourceConnectionId: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  sourceGuildId: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  sourceConversationId: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  /** Parent channel used for policy checks when the exact source is a Discord thread. */
  sourceParentConversationId: Schema.optionalKey(
    Schema.String.pipe(
      Schema.check(Schema.isTrimmed()),
      Schema.check(Schema.isPattern(/^[1-9][0-9]{16,19}$/)),
    ),
  ),
  sourceMessageId: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  sourceKind: Schema.Literals(['channel', 'thread']),
  sourceAuthorId: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  destinationConnectionId: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  ),
  destinationGuildId: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  destinationConversationId: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  ),
  destinationKind: Schema.Literal('channel'),
})
export type LinkedDiscordSource = typeof LinkedDiscordSource.Type

export const ChannelThread = Schema.Struct({
  ...ThreadFields,
  audience: Schema.Literal('user'),
  parent: Schema.Null,
  channelContext: ChannelContext,
  conversationBinding: ConversationBinding,
  /** Immutable provenance for a channel thread created from an exact Discord link. */
  linkedDiscordSource: Schema.optionalKey(LinkedDiscordSource),
})
export type ChannelThread = typeof ChannelThread.Type

export const AgentThread = Schema.Struct({
  ...ThreadFields,
  audience: Schema.Literal('agent'),
  parent: ParentReference,
  role: AgentRole,
  subagentProfile: Schema.optionalKey(SubagentProfileName),
  mayWrite: Schema.optionalKey(Schema.Boolean),
  primaryWorkingDirectory: Schema.optionalKey(WorkingDirectory),
  conversationBinding: Schema.Null,
})
export type AgentThread = typeof AgentThread.Type

export const Thread = Schema.Union([ChannelThread, AgentThread])
export type Thread = typeof Thread.Type
