import type { ContextMessage, InputMessage, MessageAuthor } from '@friday/contracts/conversation'
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
})
export interface PromptHistoricalMessage extends Schema.Schema.Type<
  typeof PromptHistoricalMessage
> {}

export const PromptReplyTarget = Schema.Struct({
  kind: Schema.Literal('reply-target'),
  participantId: Schema.String,
  platformMessageId: Schema.optionalKey(Schema.String),
  content: Schema.String,
})
export interface PromptReplyTarget extends Schema.Schema.Type<typeof PromptReplyTarget> {}

export const PromptTrigger = Schema.Struct({
  kind: Schema.Literal('trigger'),
  participantId: Schema.String,
  platformMessageId: Schema.optionalKey(Schema.String),
  replyTargetParticipantId: Schema.optionalKey(Schema.String),
  content: Schema.String,
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
    return {
      kind: 'historical',
      participantId: participantFor(message.author).id,
      ...(messageId === undefined ? {} : { platformMessageId: messageId }),
      content: message.content.text,
    }
  })
  const triggerParticipant = participantFor(trigger.author)
  const triggerMessageId = platformMessageId(trigger)
  const replyTargetMessageId = replyTo === undefined ? undefined : platformMessageId(replyTo)
  const replyTarget: PromptReplyTarget | undefined =
    replyTo === undefined || replyTargetParticipant === undefined
      ? undefined
      : {
          kind: 'reply-target',
          participantId: replyTargetParticipant.id,
          ...(replyTargetMessageId === undefined
            ? {}
            : { platformMessageId: replyTargetMessageId }),
          content: replyTo.content.text,
        }
  const envelope: PromptMessageEnvelope = {
    kind: 'user-message',
    participants: Array.from(participants.values()),
    historicalContext,
    ...(replyTarget === undefined ? {} : { replyTarget }),
    trigger: {
      kind: 'trigger',
      participantId: triggerParticipant.id,
      ...(triggerMessageId === undefined ? {} : { platformMessageId: triggerMessageId }),
      ...(replyTargetParticipant === undefined
        ? {}
        : { replyTargetParticipantId: replyTargetParticipant.id }),
      content: trigger.content.text,
    },
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
