import * as Schema from 'effect/Schema'

import { PlatformMessageId } from './platform.ts'
import { AttachmentId } from './ids.ts'
import { NonNegativeInt } from './scalar.ts'

export const InputSource = Schema.Literals(['user', 'agent', 'system'])
export type InputSource = typeof InputSource.Type

export const AttachmentStorageReference = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Schema.brand('AttachmentStorageReference'),
)
export type AttachmentStorageReference = typeof AttachmentStorageReference.Type

export const ImageAttachment = Schema.Struct({
  id: AttachmentId,
  name: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  mediaType: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  sizeBytes: NonNegativeInt,
  storageReference: AttachmentStorageReference,
})
export type ImageAttachment = typeof ImageAttachment.Type

export const MessageContent = Schema.Struct({
  text: Schema.String,
  images: Schema.Array(ImageAttachment),
}).pipe(
  Schema.check(
    Schema.makeFilter((message) => message.text.trim().length > 0 || message.images.length > 0, {
      message: 'Message content must contain text or at least one image',
    }),
  ),
)
export type MessageContent = typeof MessageContent.Type

export const MessageAuthor = Schema.Struct({
  platformUserId: Schema.String.pipe(
    Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
    Schema.brand('PlatformUserId'),
  ),
  mention: Schema.NullOr(Schema.String),
  username: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
})
export type MessageAuthor = typeof MessageAuthor.Type

export const ContextMessage = Schema.Struct({
  author: MessageAuthor,
  content: MessageContent,
  platformMessageId: Schema.optionalKey(PlatformMessageId),
})
export type ContextMessage = typeof ContextMessage.Type

export const InputMessage = Schema.Struct({
  source: InputSource,
  author: Schema.optionalKey(MessageAuthor),
  content: MessageContent,
  platformMessageId: Schema.optionalKey(PlatformMessageId),
  context: Schema.optionalKey(Schema.Array(ContextMessage)),
  /** The Platform message this input replies to, when the Platform embeds it. */
  replyTo: Schema.optionalKey(ContextMessage),
})
export type InputMessage = typeof InputMessage.Type
