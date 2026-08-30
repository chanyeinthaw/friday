import * as Schema from 'effect/Schema'

const PlatformIdentifier = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

export const PlatformChannelId = PlatformIdentifier.pipe(Schema.brand('PlatformChannelId'))
export type PlatformChannelId = typeof PlatformChannelId.Type

export const PlatformMessageId = PlatformIdentifier.pipe(Schema.brand('PlatformMessageId'))
export type PlatformMessageId = typeof PlatformMessageId.Type

export const PlatformConversationId = PlatformIdentifier.pipe(
  Schema.brand('PlatformConversationId'),
)
export type PlatformConversationId = typeof PlatformConversationId.Type

export const PlatformConnectionId = PlatformIdentifier.pipe(Schema.brand('PlatformConnectionId'))
export type PlatformConnectionId = typeof PlatformConnectionId.Type

export const PlatformKind = Schema.Literals(['discord', 'slack', 'linear', 'web', 'test'])
export type PlatformKind = typeof PlatformKind.Type

export const ConversationBinding = Schema.Struct({
  platform: PlatformKind,
  connectionId: PlatformConnectionId,
  channelId: PlatformChannelId,
  sourceMessageId: PlatformMessageId,
  conversationId: PlatformConversationId,
})
export type ConversationBinding = typeof ConversationBinding.Type
