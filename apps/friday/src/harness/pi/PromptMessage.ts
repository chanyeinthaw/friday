import {
  ImageAttachment,
  type ContextMessage,
  type InputMessage,
  type MessageAuthor,
  type MessageContent,
} from '@friday/contracts/conversation'
import * as Schema from 'effect/Schema'

export const PromptParticipant = Schema.Struct({
  id: Schema.String,
  platformUserId: Schema.String,
  mention: Schema.NullOr(Schema.String),
  username: Schema.NullOr(Schema.String),
  displayName: Schema.NullOr(Schema.String),
})
export interface PromptParticipant extends Schema.Schema.Type<typeof PromptParticipant> {}

export const PromptHistoricalMessage = Schema.Struct({
  kind: Schema.Literal('historical'),
  participantId: Schema.String,
  platformMessageId: Schema.optionalKey(Schema.String),
  content: Schema.String,
  images: Schema.optionalKey(Schema.Array(ImageAttachment)),
})
export interface PromptHistoricalMessage extends Schema.Schema.Type<
  typeof PromptHistoricalMessage
> {}

export const PromptReplyTarget = Schema.Struct({
  kind: Schema.Literal('reply-target'),
  participantId: Schema.String,
  platformMessageId: Schema.optionalKey(Schema.String),
  content: Schema.String,
  images: Schema.optionalKey(Schema.Array(ImageAttachment)),
})
export interface PromptReplyTarget extends Schema.Schema.Type<typeof PromptReplyTarget> {}

export const PromptTrigger = Schema.Struct({
  kind: Schema.Literal('trigger'),
  participantId: Schema.String,
  platformMessageId: Schema.optionalKey(Schema.String),
  replyTargetParticipantId: Schema.optionalKey(Schema.String),
  content: Schema.String,
  images: Schema.optionalKey(Schema.Array(ImageAttachment)),
})
export interface PromptTrigger extends Schema.Schema.Type<typeof PromptTrigger> {}

export const PromptMessageEnvelope = Schema.Struct({
  kind: Schema.Literal('user-message'),
  participants: Schema.Array(PromptParticipant),
  historicalContext: Schema.Array(PromptHistoricalMessage),
  replyTarget: Schema.optionalKey(PromptReplyTarget),
  trigger: PromptTrigger,
})
export interface PromptMessageEnvelope extends Schema.Schema.Type<typeof PromptMessageEnvelope> {}

export const PromptMessageEnvelopeJson = Schema.fromJsonString(PromptMessageEnvelope)

const encodePromptMessageEnvelope = Schema.encodeSync(PromptMessageEnvelopeJson)
const authorKey = (author: MessageAuthor): string => author.platformUserId
const platformMessageId = (message: ContextMessage | InputMessage): string | undefined =>
  message.platformMessageId === undefined ? undefined : String(message.platformMessageId)
const promptContent = (content: MessageContent) =>
  content.images.length === 0
    ? { content: content.text }
    : { content: content.text, images: [...content.images] }

const renderAttributedConversation = (
  trigger: InputMessage & { readonly author: MessageAuthor },
  context: ReadonlyArray<ContextMessage>,
  replyTo: ContextMessage | undefined,
): string => {
  const participants = new Map<string, PromptParticipant>()
  const participantFor = (author: MessageAuthor): PromptParticipant => {
    const key = authorKey(author)
    const existing = participants.get(key)
    if (existing !== undefined) return existing
    const participant: PromptParticipant = {
      id: `p${participants.size + 1}`,
      platformUserId: String(author.platformUserId),
      mention: author.mention,
      username: author.username,
      displayName: author.displayName,
    }
    participants.set(key, participant)
    return participant
  }

  const replyTargetParticipant = replyTo === undefined ? undefined : participantFor(replyTo.author)
  const replyToId = replyTo?.platformMessageId
  const deduplicatedContext =
    replyToId === undefined
      ? context
      : context.filter((message) => message.platformMessageId !== replyToId)
  const historicalContext = deduplicatedContext.map((message): PromptHistoricalMessage => {
    const messageId = platformMessageId(message)
    return messageId === undefined
      ? {
          kind: 'historical',
          participantId: participantFor(message.author).id,
          ...promptContent(message.content),
        }
      : {
          kind: 'historical',
          participantId: participantFor(message.author).id,
          platformMessageId: messageId,
          ...promptContent(message.content),
        }
  })
  const triggerParticipant = participantFor(trigger.author)
  const triggerMessageId = platformMessageId(trigger)
  const replyTargetMessageId = replyTo === undefined ? undefined : platformMessageId(replyTo)
  const replyTarget: PromptReplyTarget | undefined =
    replyTo === undefined || replyTargetParticipant === undefined
      ? undefined
      : replyTargetMessageId === undefined
        ? {
            kind: 'reply-target',
            participantId: replyTargetParticipant.id,
            ...promptContent(replyTo.content),
          }
        : {
            kind: 'reply-target',
            participantId: replyTargetParticipant.id,
            platformMessageId: replyTargetMessageId,
            ...promptContent(replyTo.content),
          }
  let triggerEnvelope: PromptTrigger
  if (triggerMessageId === undefined) {
    triggerEnvelope =
      replyTargetParticipant === undefined
        ? {
            kind: 'trigger',
            participantId: triggerParticipant.id,
            ...promptContent(trigger.content),
          }
        : {
            kind: 'trigger',
            participantId: triggerParticipant.id,
            replyTargetParticipantId: replyTargetParticipant.id,
            ...promptContent(trigger.content),
          }
  } else {
    triggerEnvelope =
      replyTargetParticipant === undefined
        ? {
            kind: 'trigger',
            participantId: triggerParticipant.id,
            platformMessageId: triggerMessageId,
            ...promptContent(trigger.content),
          }
        : {
            kind: 'trigger',
            participantId: triggerParticipant.id,
            platformMessageId: triggerMessageId,
            replyTargetParticipantId: replyTargetParticipant.id,
            ...promptContent(trigger.content),
          }
  }
  const envelope: PromptMessageEnvelope =
    replyTarget === undefined
      ? {
          kind: 'user-message',
          participants: Array.from(participants.values()),
          historicalContext,
          trigger: triggerEnvelope,
        }
      : {
          kind: 'user-message',
          participants: Array.from(participants.values()),
          historicalContext,
          replyTarget,
          trigger: triggerEnvelope,
        }
  return encodePromptMessageEnvelope(envelope)
}

/** Attributes one triggering channel message while leaving internal messages unchanged. */
export const renderPromptMessage = (message: InputMessage): string => {
  if (message.source !== 'user' || message.author === undefined) return message.content.text
  return renderAttributedConversation(
    { ...message, author: message.author },
    message.context ?? [],
    message.replyTo,
  )
}
