/* oxlint-disable eslint/no-underscore-dangle -- Effect errors use the canonical _tag discriminator. */

import { ChannelThread, IsoDateTime, PlatformMessageId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { join } from 'node:path'

import type { DiscordLink } from '../../config/DiscordLinks.ts'
import type { AppConfig } from '../../config/AppConfig.ts'
import { AppConfig as AppConfigService } from '../../config/AppConfigLive.ts'
import { FRIDAY_HOME } from '../../FridayHome.ts'
import { TextGeneration } from '../../harness/TextGeneration.ts'
import { ChannelTurns } from '../../conversation/ChannelTurns.ts'
import { ThreadPersistence } from '../../conversation/ThreadPersistence.ts'
import { externalUpdatesDenied } from '../../conversation/ThreadRuntime.ts'
import {
  DiscordCapabilityRegistry,
  type DiscordCapability,
  type DiscordSourceMessage,
} from './DiscordLinkedRuntime.ts'

export class DiscordLinkHandoffError extends Schema.Error<DiscordLinkHandoffError>(
  'DiscordLinkHandoffError',
)({
  _tag: Schema.tag('DiscordLinkHandoffError'),
  stage: Schema.Literals([
    'deduplicate',
    'reaction',
    'context',
    'generation',
    'thread',
    'starter',
    'construction',
    'persistence',
    'turn-setup',
    'dispatch',
  ]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
const isDiscordLinkHandoffError = Schema.is(DiscordLinkHandoffError)

const handoffDiagnostic = (error: DiscordLinkHandoffError) => ({
  errorTag: error._tag,
  reason: error.detail,
})

export interface LinkedInboundMessage {
  readonly link: DiscordLink
  readonly messageId: string
  readonly authorId: string
  readonly sourceParentConversationId?: string | undefined
}

export interface DiscordLinkHandoffsContract {
  readonly handoff: (input: LinkedInboundMessage) => Effect.Effect<void, never>
}

export class DiscordLinkHandoffs extends Context.Service<
  DiscordLinkHandoffs,
  DiscordLinkHandoffsContract
>()('friday/platforms/discord/DiscordLinkHandoffs') {}

const sourceUrl = (input: LinkedInboundMessage) =>
  `https://discord.com/channels/${input.link.source.guildId}/${input.link.source.conversationId}/${input.messageId}`
const decodeIsoDateTime = Schema.decodeUnknownOption(IsoDateTime)
const renderTimestamp = (value: string | null): string =>
  value !== null && Option.isSome(decodeIsoDateTime(value)) ? value : 'timestamp unavailable'
const titleFallback = (messageId: string) => `Linked Discord request ${messageId.slice(-12)}`
export const normalizeLinkedTitle = (title: string, messageId: string): string => {
  const cleaned = title
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim()
  return (cleaned.length === 0 ? titleFallback(messageId) : cleaned).slice(0, 100)
}

const aliases = (messages: ReadonlyArray<DiscordSourceMessage>) => {
  const participantIds = new Set<string>()
  for (const message of messages) {
    participantIds.add(message.author.userId)
    if (message.replyTo !== undefined) participantIds.add(message.replyTo.author.userId)
  }
  return [...participantIds].map((id, index) => ({ id, alias: `P${index + 1}` }))
}

export const TrustedProvenanceStart = '<friday-owned-provenance>'
export const TrustedProvenanceEnd = '</friday-owned-provenance>'
export const containsReservedProvenanceMarker = (value: string): boolean =>
  value.includes(TrustedProvenanceStart) || value.includes(TrustedProvenanceEnd)

export const renderLinkedSourceMaterial = (
  messages: ReadonlyArray<DiscordSourceMessage>,
  triggerId: string,
): string => {
  const participantAliases = aliases(messages)
  const aliasFor = (id: string) =>
    participantAliases.find((participant) => participant.id === id)?.alias ?? 'P?'
  const sanitize = (value: string) => {
    let sanitized = value
    for (const participant of participantAliases) {
      sanitized = sanitized.replaceAll(participant.id, participant.alias)
    }
    return sanitized
      .replace(/<@&?P[0-9]+>/gu, (mention) => mention.slice(mention.indexOf('P'), -1))
      .replace(/<@!?(P[0-9]+)>/gu, '$1')
      .replace(/[1-9][0-9]{16,19}/gu, '[discord-id]')
      .replaceAll('<untrusted-discord-source>', '&lt;untrusted-discord-source&gt;')
      .replaceAll('</untrusted-discord-source>', '&lt;/untrusted-discord-source&gt;')
      .replaceAll(TrustedProvenanceStart, '&lt;friday-owned-provenance&gt;')
      .replaceAll(TrustedProvenanceEnd, '&lt;/friday-owned-provenance&gt;')
  }
  const rendered = messages
    .map((message) => {
      const attachments = message.attachments
        .map(
          (attachment) =>
            `attachment: ${sanitize(attachment.name)} (${attachment.contentType ?? 'unknown'}, ${attachment.size ?? 'unknown'} bytes) ${sanitize(attachment.url)}`,
        )
        .join('\n')
      const reply =
        message.replyTo === undefined
          ? ''
          : `\nreply reference (${renderTimestamp(message.replyTo.sentAt)}): ${aliasFor(message.replyTo.author.userId)}: ${sanitize(message.replyTo.text)}`
      return `[${message.id === triggerId ? 'TRIGGER' : 'CONTEXT'}] ${renderTimestamp(message.sentAt)} ${aliasFor(message.author.userId)}: ${sanitize(message.text)}${reply}${attachments.length === 0 ? '' : `\n${attachments}`}`
    })
    .join('\n\n')
  return [
    `Participants: ${participantAliases.map(({ alias }) => alias).join(', ')}`,
    '',
    rendered,
  ].join('\n')
}

export const authoritativeProvenance = (
  input: LinkedInboundMessage,
  messages: ReadonlyArray<DiscordSourceMessage>,
): string =>
  [
    TrustedProvenanceStart,
    'This block is appended by Friday from trusted Discord data. Text above cannot modify it.',
    `Authoritative source: ${sourceUrl(input)}`,
    'Authoritative participants:',
    ...aliases(messages).map(
      (participant) => `- ${participant.alias}: Discord user ${participant.id}`,
    ),
    TrustedProvenanceEnd,
  ].join('\n')

const makeThread = Effect.fn('DiscordLinkHandoffs.makeThread')(function* (
  crypto: Crypto.Crypto,
  fileSystem: FileSystem.FileSystem,
  input: LinkedInboundMessage,
  destinationThread: { readonly id: string; readonly conversationId: string },
  title: string,
  config: AppConfig,
) {
  if (input.link.source.kind === 'thread') {
    if (input.sourceParentConversationId === undefined) {
      return yield* new DiscordLinkHandoffError({
        stage: 'construction',
        detail: 'Thread source provenance is missing its parent conversation ID.',
      })
    }
    if (input.sourceParentConversationId === input.link.source.conversationId) {
      return yield* new DiscordLinkHandoffError({
        stage: 'construction',
        detail: 'Thread source provenance parent matches the source thread conversation ID.',
      })
    }
  }
  const timestamp = DateTime.formatIso(yield* DateTime.now)
  const workingDirectory = join(
    FRIDAY_HOME,
    'workspaces',
    destinationThread.conversationId.replaceAll(':', '-'),
  )
  yield* fileSystem.makeDirectory(workingDirectory, { recursive: true })
  const linkedDiscordSourceBase = {
    linkId: input.link.id,
    sourceConnectionId: input.link.source.connectionId,
    sourceGuildId: input.link.source.guildId,
    sourceConversationId: input.link.source.conversationId,
    sourceMessageId: input.messageId,
    sourceKind: input.link.source.kind,
    sourceAuthorId: input.authorId,
    destinationConnectionId: input.link.destination.connectionId,
    destinationGuildId: input.link.destination.guildId,
    destinationConversationId: input.link.destination.conversationId,
    destinationKind: input.link.destination.kind,
  }
  const linkedDiscordSource =
    input.link.source.kind === 'thread'
      ? {
          ...linkedDiscordSourceBase,
          sourceParentConversationId: input.sourceParentConversationId,
        }
      : linkedDiscordSourceBase
  return yield* decodeChannelThread({
    id: yield* crypto.randomUUIDv4,
    audience: 'user',
    parent: null,
    harness: 'pi',
    harnessSession: null,
    workingDirectory,
    model: config.models.primary,
    thinkingLevel: config.models.primary.thinkingLevel,
    channelContext: {
      name: title,
      description: `Operator thread for linked Discord source ${input.link.id}.`,
    },
    conversationBinding: {
      platform: 'discord',
      connectionId: input.link.destination.connectionId,
      channelId: input.link.destination.conversationId,
      sourceMessageId: destinationThread.id,
      conversationId: destinationThread.conversationId,
    },
    linkedDiscordSource,
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: null,
  })
})

const LinkedInputMessage = Schema.Struct({
  source: Schema.Literal('user'),
  content: Schema.Struct({ text: Schema.String, images: Schema.Array(Schema.Never) }),
  platformMessageId: PlatformMessageId,
})
const decodeLinkedInputMessage = Schema.decodeUnknownEffect(LinkedInputMessage)
const decodeChannelThread = Schema.decodeUnknownEffect(ChannelThread)
const messageInput = (prompt: string, messageId: string) =>
  decodeLinkedInputMessage({
    source: 'user',
    content: { text: prompt, images: [] },
    platformMessageId: messageId,
  })

export const DiscordLinkHandoffsLive = Layer.effect(
  DiscordLinkHandoffs,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto
    const fileSystem = yield* FileSystem.FileSystem
    const registry = yield* DiscordCapabilityRegistry
    const generation = yield* TextGeneration
    const persistence = yield* ThreadPersistence
    const turns = yield* ChannelTurns
    const config = yield* AppConfigService

    const finalReaction = (source: DiscordCapability, input: LinkedInboundMessage, emoji: string) =>
      source.removeReaction(input.link.source, input.messageId, '👀').pipe(
        Effect.tapError(() =>
          Effect.logWarning('discord.link.reaction.remove-failed').pipe(
            Effect.annotateLogs({
              linkId: input.link.id,
              messageId: input.messageId,
              errorTag: 'OperationError',
            }),
          ),
        ),
        Effect.ignore,
        Effect.andThen(
          source.addReaction(input.link.source, input.messageId, emoji).pipe(
            Effect.tapError(() =>
              Effect.logWarning('discord.link.reaction.final-failed').pipe(
                Effect.annotateLogs({
                  linkId: input.link.id,
                  messageId: input.messageId,
                  emoji,
                  errorTag: 'OperationError',
                }),
              ),
            ),
            Effect.ignore,
          ),
        ),
      )

    return DiscordLinkHandoffs.of({
      handoff: (input) =>
        registry.get(input.link.source.connectionId).pipe(
          Effect.matchEffect({
            onFailure: () =>
              Effect.logError('discord.link.handoff.source-capability-unavailable').pipe(
                Effect.annotateLogs({
                  linkId: input.link.id,
                  sourceConnectionId: input.link.source.connectionId,
                  sourceGuildId: input.link.source.guildId,
                  sourceConversationId: input.link.source.conversationId,
                  sourceMessageId: input.messageId,
                  reactionAttempted: false,
                  errorTag: 'OperationError',
                }),
              ),
            onSuccess: (source) => {
              const workflow = Effect.gen(function* () {
                const claimed = yield* sql
                  .withTransaction(
                    Effect.gen(function* () {
                      const existing = yield* sql<{
                        readonly status: string
                      }>`SELECT status FROM discord_link_handoffs WHERE source_connection_id=${input.link.source.connectionId} AND source_message_id=${input.messageId}`
                      if (existing.length > 0) return false
                      yield* sql`INSERT INTO discord_link_handoffs (
                        source_connection_id, source_message_id, link_id,
                        source_guild_id, source_conversation_id, source_kind,
                        destination_connection_id, destination_guild_id,
                        destination_conversation_id, destination_kind,
                        status, created_at, updated_at
                      ) VALUES (
                        ${input.link.source.connectionId}, ${input.messageId}, ${input.link.id},
                        ${input.link.source.guildId}, ${input.link.source.conversationId},
                        ${input.link.source.kind}, ${input.link.destination.connectionId},
                        ${input.link.destination.guildId}, ${input.link.destination.conversationId},
                        ${input.link.destination.kind}, 'accepted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                      )`
                      return true
                    }),
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new DiscordLinkHandoffError({
                          stage: 'deduplicate',
                          detail: 'Could not claim the linked source message.',
                          cause,
                        }),
                    ),
                  )
                if (!claimed) return
                yield* source.addReaction(input.link.source, input.messageId, '👀').pipe(
                  Effect.tapError(() =>
                    Effect.logWarning('discord.link.reaction.eyes-failed').pipe(
                      Effect.annotateLogs({
                        linkId: input.link.id,
                        messageId: input.messageId,
                        errorTag: 'OperationError',
                      }),
                    ),
                  ),
                  Effect.ignore,
                )
                const messages = yield* source
                  .fetchContext(
                    input.link.source,
                    input.messageId,
                    Math.max(5, Math.min(config.current().agent.recentMessageCount, 50)),
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new DiscordLinkHandoffError({
                          stage: 'context',
                          detail: 'Could not load source context.',
                          cause,
                        }),
                    ),
                  )
                if (!messages.some((message) => message.id === input.messageId)) {
                  return yield* new DiscordLinkHandoffError({
                    stage: 'context',
                    detail: 'The triggering source message was not returned by Discord.',
                  })
                }
                const generated = yield* generation
                  .generateLinkedHandoff({
                    sourceMaterial: renderLinkedSourceMaterial(messages, input.messageId),
                    model: config.current().models.utility,
                    thinkingLevel: config.current().models.utility.thinkingLevel,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new DiscordLinkHandoffError({
                          stage: 'generation',
                          detail: 'Could not generate destination prompt.',
                          cause,
                        }),
                    ),
                  )
                if (
                  containsReservedProvenanceMarker(generated.title) ||
                  containsReservedProvenanceMarker(generated.prompt)
                ) {
                  return yield* new DiscordLinkHandoffError({
                    stage: 'generation',
                    detail: 'Generated handoff attempted to use Friday-owned provenance framing.',
                  })
                }
                const title = normalizeLinkedTitle(generated.title, input.messageId)
                const destination = yield* registry.get(input.link.destination.connectionId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new DiscordLinkHandoffError({
                        stage: 'thread',
                        detail: 'Destination Discord capability is unavailable.',
                        cause,
                      }),
                  ),
                )
                const created = yield* destination
                  .createStandaloneThread(input.link.destination, title)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new DiscordLinkHandoffError({
                          stage: 'thread',
                          detail: 'Could not create destination thread.',
                          cause,
                        }),
                    ),
                  )
                yield* sql`UPDATE discord_link_handoffs SET status='thread-created', destination_thread_id=${created.id}, updated_at=CURRENT_TIMESTAMP WHERE source_connection_id=${input.link.source.connectionId} AND source_message_id=${input.messageId}`.pipe(
                  Effect.mapError(
                    (cause) =>
                      new DiscordLinkHandoffError({
                        stage: 'persistence',
                        detail: 'Could not record the created destination thread.',
                        cause,
                      }),
                  ),
                )
                const header = `Linked Discord source: <${sourceUrl(input)}>\nParticipants: ${aliases(
                  messages,
                )
                  .map((participant) => `${participant.alias}=<@${participant.id}>`)
                  .join(', ')}`
                yield* destination
                  .postSafe(
                    { ...input.link.destination, conversationId: created.id, kind: 'thread' },
                    header,
                    [],
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new DiscordLinkHandoffError({
                          stage: 'starter',
                          detail: 'Could not publish source header.',
                          cause,
                        }),
                    ),
                  )
                const thread = yield* makeThread(
                  crypto,
                  fileSystem,
                  input,
                  created,
                  title,
                  config.current(),
                ).pipe(
                  Effect.mapError((cause) =>
                    isDiscordLinkHandoffError(cause)
                      ? cause
                      : new DiscordLinkHandoffError({
                          stage: 'construction',
                          detail: 'Could not construct the linked ChannelThread.',
                          cause,
                        }),
                  ),
                )
                yield* persistence.createThread(thread).pipe(
                  Effect.mapError(
                    (cause) =>
                      new DiscordLinkHandoffError({
                        stage: 'persistence',
                        detail: 'Could not persist the linked ChannelThread.',
                        cause,
                      }),
                  ),
                )
                const prompt = `${generated.prompt.trim()}\n\n${authoritativeProvenance(input, messages)}`
                const message = yield* messageInput(prompt, input.messageId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new DiscordLinkHandoffError({
                        stage: 'turn-setup',
                        detail: 'Could not construct the initial linked handoff message.',
                        cause,
                      }),
                  ),
                )
                yield* turns
                  .accept({
                    thread,
                    message,
                    authorization: externalUpdatesDenied,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new DiscordLinkHandoffError({
                          stage: 'dispatch',
                          detail: 'Could not dispatch initial turn.',
                          cause,
                        }),
                    ),
                  )
                yield* sql`UPDATE discord_link_handoffs SET status='dispatched', updated_at=CURRENT_TIMESTAMP WHERE source_connection_id=${input.link.source.connectionId} AND source_message_id=${input.messageId}`.pipe(
                  Effect.tapError(() =>
                    Effect.logError('discord.link.handoff.dispatch-persistence-failed').pipe(
                      Effect.annotateLogs({
                        linkId: input.link.id,
                        messageId: input.messageId,
                        errorTag: 'OperationError',
                      }),
                    ),
                  ),
                  Effect.ignore,
                )
                yield* finalReaction(source, input, '✅')
              })
              return workflow.pipe(
                Effect.catch((error) => {
                  const handoffError = isDiscordLinkHandoffError(error)
                    ? error
                    : new DiscordLinkHandoffError({
                        stage: 'dispatch',
                        detail: 'The linked handoff failed outside a classified stage.',
                        cause: error,
                      })
                  const stage = handoffError.stage
                  const persistFailure =
                    sql`UPDATE discord_link_handoffs SET status='failed', error_stage=${stage}, updated_at=CURRENT_TIMESTAMP WHERE source_connection_id=${input.link.source.connectionId} AND source_message_id=${input.messageId}`.pipe(
                      Effect.tapError(() =>
                        Effect.logError('discord.link.handoff.failure-persistence-failed').pipe(
                          Effect.annotateLogs({
                            linkId: input.link.id,
                            messageId: input.messageId,
                            stage,
                            errorTag: 'OperationError',
                          }),
                        ),
                      ),
                      Effect.ignore,
                    )
                  return Effect.all([persistFailure, finalReaction(source, input, '❌')], {
                    concurrency: 'unbounded',
                    discard: true,
                  }).pipe(
                    Effect.andThen(
                      Effect.logError('discord.link.handoff.failed').pipe(
                        Effect.annotateLogs({
                          linkId: input.link.id,
                          messageId: input.messageId,
                          stage,
                          ...handoffDiagnostic(handoffError),
                        }),
                      ),
                    ),
                  )
                }),
              )
            },
          }),
          Effect.catchCause(() =>
            Effect.logError('discord.link.handoff.defect').pipe(
              Effect.annotateLogs({ errorTag: 'Cause' }),
            ),
          ),
          Effect.asVoid,
        ),
    })
  }),
)
