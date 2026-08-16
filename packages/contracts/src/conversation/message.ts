import * as Schema from 'effect/Schema'

import { ExternalMessageId } from './external.ts'
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

export const InputMessage = Schema.Struct({
  source: InputSource,
  content: MessageContent,
  externalMessageId: Schema.optionalKey(ExternalMessageId),
})
export type InputMessage = typeof InputMessage.Type
