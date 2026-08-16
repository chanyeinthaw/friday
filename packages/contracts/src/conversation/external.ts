import * as Schema from 'effect/Schema'

const ExternalIdentifier = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

export const ExternalChannelId = ExternalIdentifier.pipe(Schema.brand('ExternalChannelId'))
export type ExternalChannelId = typeof ExternalChannelId.Type

export const ExternalMessageId = ExternalIdentifier.pipe(Schema.brand('ExternalMessageId'))
export type ExternalMessageId = typeof ExternalMessageId.Type

export const ExternalThreadId = ExternalIdentifier.pipe(Schema.brand('ExternalThreadId'))
export type ExternalThreadId = typeof ExternalThreadId.Type

export const ExternalPlatform = Schema.Literals(['discord', 'slack'])
export type ExternalPlatform = typeof ExternalPlatform.Type

export const ExternalBinding = Schema.Struct({
  platform: ExternalPlatform,
  channelId: ExternalChannelId,
  sourceMessageId: ExternalMessageId,
  externalThreadId: ExternalThreadId,
})
export type ExternalBinding = typeof ExternalBinding.Type
