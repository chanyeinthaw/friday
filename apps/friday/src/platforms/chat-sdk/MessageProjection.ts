import {
  ContextMessage,
  ImageAttachment,
  MessageAuthor,
  PlatformChannelId,
  PlatformConnectionId,
  PlatformConversationId,
  PlatformKind,
  PlatformMessageId,
  type ConversationBinding,
  type ImageAttachment as ImageAttachmentType,
  type InputMessage,
  type MessageContent,
} from '@friday/contracts/conversation'
import type { Attachment, Message, Thread } from 'chat'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'

const decodePlatform = Schema.decodeUnknownSync(PlatformKind)
const decodeConnectionId = Schema.decodeUnknownSync(PlatformConnectionId)
const decodeChannelId = Schema.decodeUnknownSync(PlatformChannelId)
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeThreadId = Schema.decodeUnknownSync(PlatformConversationId)
const decodeImageAttachment = Schema.decodeUnknownOption(ImageAttachment)

export interface ChatSdkThreadProjectionSource extends Pick<Thread, 'channelId' | 'id'> {
  readonly adapter: Pick<Thread['adapter'], 'name'>
}

type ChatSdkAttachmentProjectionSource = Pick<
  Attachment,
  'type' | 'url' | 'name' | 'mimeType' | 'size'
>

export type ChatSdkMessageProjectionSource = Pick<
  Message,
  'author' | 'id' | 'text' | 'isMention' | 'raw'
> & {
  readonly attachments?: ReadonlyArray<ChatSdkAttachmentProjectionSource>
}

/** Context projection accepts attachment metadata without requiring a raw payload. */
export type ChatSdkContextMessageSource = Pick<
  ChatSdkMessageProjectionSource,
  'author' | 'id' | 'text'
> & {
  readonly raw?: unknown
  readonly attachments?: ReadonlyArray<ChatSdkAttachmentProjectionSource>
}

const DiscordReplyAuthor = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  username: Schema.optionalKey(Schema.String),
  global_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const DiscordReferencedMessage = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  content: Schema.optionalKey(Schema.String),
  author: DiscordReplyAuthor,
  attachments: Schema.optionalKey(Schema.Unknown),
})

// Discord MESSAGE_REPLY is type 19; only such payloads carry reply intent.
const DiscordRawMessage = Schema.Struct({
  type: Schema.Literal(19),
  referenced_message: Schema.optionalKey(Schema.NullOr(DiscordReferencedMessage)),
})

const DiscordRawAttachments = Schema.Struct({
  attachments: Schema.optionalKey(Schema.Unknown),
})
const DiscordAttachment = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  content_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  size: Schema.Finite,
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const UnknownAttachments = Schema.Array(Schema.Unknown)

const decodeRawReply = Schema.decodeUnknownOption(DiscordRawMessage)
const decodeRawAttachments = Schema.decodeUnknownOption(DiscordRawAttachments)
const decodeUnknownAttachments = Schema.decodeUnknownOption(UnknownAttachments)
const decodeDiscordAttachment = Schema.decodeUnknownOption(DiscordAttachment)
const decodeReplyAuthor = Schema.decodeUnknownOption(MessageAuthor)
const decodeAuthor = Schema.decodeUnknownSync(MessageAuthor)

type AttachmentNoticeKind = 'malformed' | 'unsupported' | 'unavailable'

interface AttachmentCandidate {
  readonly _tag: 'candidate'
  readonly id: string
  readonly name: string | undefined
  readonly mediaType: string | null | undefined
  readonly sizeBytes: number | undefined
  readonly storageReference: string | null | undefined
}

interface AttachmentNotice {
  readonly _tag: 'notice'
  readonly text: string
}

type AttachmentEntry = AttachmentCandidate | AttachmentNotice

type ProjectedAttachment =
  | { readonly _tag: 'image'; readonly image: ImageAttachmentType }
  | AttachmentNotice

interface AttachmentProjection {
  readonly images: Array<ImageAttachmentType>
  readonly notices: Array<string>
}

const attachmentNotice = (
  kind: AttachmentNoticeKind,
  name?: string,
  mediaType?: string | null,
): string => {
  const label = name === undefined || name.trim().length === 0 ? 'unnamed attachment' : name
  if (kind === 'unsupported') {
    return `[Discord attachment unsupported: ${label}${mediaType ? ` (${mediaType})` : ''}]`
  }
  if (kind === 'unavailable') return `[Discord attachment unavailable: ${label}]`
  return `[Discord attachment metadata malformed: ${label}]`
}

const noticeEntry = (text: string): AttachmentNotice => ({ _tag: 'notice', text })

const projectAttachment = (
  candidate: AttachmentCandidate,
  fallbackId: string,
): ProjectedAttachment => {
  const name = candidate.name
  const mediaType = candidate.mediaType
  if (
    name === undefined ||
    name.trim().length === 0 ||
    mediaType === undefined ||
    mediaType === null ||
    mediaType.trim().length === 0 ||
    candidate.sizeBytes === undefined ||
    !Number.isInteger(candidate.sizeBytes) ||
    candidate.sizeBytes < 0
  ) {
    return noticeEntry(attachmentNotice('malformed', name))
  }
  if (!mediaType.toLowerCase().startsWith('image/')) {
    return noticeEntry(attachmentNotice('unsupported', name, mediaType))
  }
  const storageReference = candidate.storageReference
  if (
    storageReference === undefined ||
    storageReference === null ||
    storageReference.trim() === ''
  ) {
    return noticeEntry(attachmentNotice('unavailable', name))
  }
  const image = Option.getOrUndefined(
    decodeImageAttachment({
      id: candidate.id.trim() === '' ? fallbackId : candidate.id,
      name,
      mediaType,
      sizeBytes: candidate.sizeBytes,
      storageReference,
    }),
  )
  return image === undefined
    ? noticeEntry(attachmentNotice('malformed', name))
    : { _tag: 'image', image }
}

const collectAttachments = (
  candidates: ReadonlyArray<AttachmentEntry>,
  messageId: string,
): AttachmentProjection => {
  const images: Array<ImageAttachmentType> = []
  const notices: Array<string> = []
  for (const [index, candidate] of candidates.entries()) {
    if (candidate._tag === 'notice') {
      notices.push(candidate.text)
      continue
    }
    const projected = projectAttachment(candidate, `attachment-${messageId}-${index + 1}`)
    if (projected._tag === 'notice') notices.push(projected.text)
    else images.push(projected.image)
  }
  return { images, notices }
}

const normalizedCandidates = (
  attachments: ReadonlyArray<ChatSdkAttachmentProjectionSource>,
): ReadonlyArray<AttachmentEntry> =>
  attachments.map((attachment) =>
    attachment.type === 'image'
      ? {
          _tag: 'candidate',
          id: '',
          name: attachment.name,
          mediaType: attachment.mimeType,
          sizeBytes: attachment.size,
          storageReference: attachment.url,
        }
      : noticeEntry(attachmentNotice('unsupported', attachment.name, attachment.mimeType)),
  )

const rawCandidates = (
  container: Schema.Schema.Type<typeof DiscordRawAttachments>,
): ReadonlyArray<AttachmentEntry> => {
  const attachments = Option.getOrUndefined(decodeUnknownAttachments(container.attachments))
  if (attachments === undefined) return [noticeEntry(attachmentNotice('malformed'))]
  return attachments.map((value) => {
    const attachment = Option.getOrUndefined(decodeDiscordAttachment(value))
    return attachment === undefined
      ? noticeEntry(attachmentNotice('malformed'))
      : {
          _tag: 'candidate',
          id: attachment.id,
          name: attachment.filename,
          mediaType: attachment.content_type,
          sizeBytes: attachment.size,
          storageReference: attachment.url,
        }
  })
}

const projectContent = (
  platform: ConversationBinding['platform'],
  message: ChatSdkContextMessageSource,
): MessageContent => {
  if (platform !== 'discord') return { text: message.text, images: [] }
  const raw = Option.getOrUndefined(decodeRawAttachments(message.raw))
  const candidates =
    raw === undefined || !Object.hasOwn(raw, 'attachments')
      ? normalizedCandidates(message.attachments ?? [])
      : rawCandidates(raw)
  const projection = collectAttachments(candidates, message.id)
  return {
    text:
      projection.notices.length === 0
        ? message.text
        : [message.text, ...projection.notices].filter((part) => part.length > 0).join('\n'),
    images: projection.images,
  }
}

const authorInput = (
  platform: ConversationBinding['platform'],
  platformUserId: string,
  username: string | null | undefined,
  displayName: string | null | undefined,
) => ({
  platformUserId,
  mention: platform === 'discord' ? `<@${platformUserId}>` : username || null,
  username: username || null,
  displayName: displayName || null,
})

const replyTargetFrom = (
  platform: ConversationBinding['platform'],
  reply: Schema.Schema.Type<typeof DiscordReferencedMessage> | null | undefined,
): ContextMessage | undefined => {
  if (reply === null || reply === undefined) return undefined
  const content = projectContent(platform, {
    author: {
      userId: reply.author.id,
      userName: reply.author.username ?? '',
      fullName: reply.author.global_name ?? reply.author.username ?? '',
      isBot: false,
      isMe: false,
    },
    id: reply.id,
    text: reply.content ?? '',
    raw: reply.attachments === undefined ? {} : { attachments: reply.attachments },
  })
  if (content.text.trim().length === 0 && content.images.length === 0) return undefined
  const author = decodeReplyAuthor(
    authorInput(platform, reply.author.id, reply.author.username, reply.author.global_name),
  )
  if (Option.isNone(author)) return undefined
  return {
    author: author.value,
    content,
    platformMessageId: decodeMessageId(reply.id),
  }
}

export const projectChatSdkContextMessage = (
  platform: ConversationBinding['platform'],
  message: ChatSdkContextMessageSource,
) => ({
  author: decodeAuthor(
    authorInput(platform, message.author.userId, message.author.userName, message.author.fullName),
  ),
  content: projectContent(platform, message),
  platformMessageId: decodeMessageId(message.id),
})

export const projectChatSdkMessage = (
  connectionId: string,
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
): PlatformInput => {
  const binding: ConversationBinding = {
    platform: decodePlatform(thread.adapter.name),
    connectionId: decodeConnectionId(connectionId),
    channelId: decodeChannelId(thread.channelId),
    sourceMessageId: decodeMessageId(message.id),
    conversationId: decodeThreadId(thread.id),
  }
  const projected = projectChatSdkContextMessage(binding.platform, message)
  const rawReply = Option.getOrUndefined(decodeRawReply(message.raw))
  const replyTo =
    binding.platform === 'discord'
      ? replyTargetFrom(binding.platform, rawReply?.referenced_message)
      : undefined
  const inputMessage: InputMessage = {
    source: 'user',
    author: projected.author,
    content: projected.content,
    platformMessageId: binding.sourceMessageId,
  }
  return { binding, message: replyTo === undefined ? inputMessage : { ...inputMessage, replyTo } }
}
