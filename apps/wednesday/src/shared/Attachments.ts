import { Schema } from 'effect'

export const maxAttachmentSize = 10 * 1024 * 1024
export const maxAttachments = 10
export const Attachment = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  mediaType: Schema.NonEmptyString,
  size: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maxAttachmentSize)),
})
export interface Attachment extends Schema.Schema.Type<typeof Attachment> {}
export const AttachmentUpload = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  mediaType: Schema.String,
  size: Attachment.fields.size,
})
export interface AttachmentUpload extends Schema.Schema.Type<typeof AttachmentUpload> {}
export const PreparedUpload = Schema.Struct({ attachment: Attachment, url: Schema.String })
export const AttachmentDownload = Schema.Struct({ attachment: Attachment, url: Schema.String })
export interface AttachmentDownload extends Schema.Schema.Type<typeof AttachmentDownload> {}
