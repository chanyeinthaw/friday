import * as Schema from 'effect/Schema'

const SurfaceIdentifier = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

export const SurfaceChannelId = SurfaceIdentifier.pipe(Schema.brand('SurfaceChannelId'))
export type SurfaceChannelId = typeof SurfaceChannelId.Type

export const SurfaceMessageId = SurfaceIdentifier.pipe(Schema.brand('SurfaceMessageId'))
export type SurfaceMessageId = typeof SurfaceMessageId.Type

export const SurfaceConversationId = SurfaceIdentifier.pipe(Schema.brand('SurfaceConversationId'))
export type SurfaceConversationId = typeof SurfaceConversationId.Type

export const SurfaceKind = Schema.Literals(['discord', 'slack'])
export type SurfaceKind = typeof SurfaceKind.Type

export const SurfaceBinding = Schema.Struct({
  surface: SurfaceKind,
  channelId: SurfaceChannelId,
  sourceMessageId: SurfaceMessageId,
  conversationId: SurfaceConversationId,
})
export type SurfaceBinding = typeof SurfaceBinding.Type
