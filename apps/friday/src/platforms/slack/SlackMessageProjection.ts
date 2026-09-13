/* oxlint-disable anti-slop/no-runtime-typeof -- Decoded Chat SDK payloads branch on optional team shapes after Schema validation at this adapter boundary. */
import {
  MessageAuthor,
  PlatformChannelId,
  PlatformConnectionId,
  PlatformConversationId,
  PlatformMessageId,
  PlatformScopeId,
} from '@friday/contracts/conversation'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { ChatSdkCallbackError } from '../chat-sdk/Errors.ts'
import type {
  ChatSdkMessageProjectionSource,
  ChatSdkThreadProjectionSource,
} from '../chat-sdk/MessageProjection.ts'
import * as Effect from 'effect/Effect'
import {
  decodeSlackAdapterThreadId,
  reconcileSlackLocation,
  slackChannelId,
  slackConversationId,
  type SlackConversationLocation,
} from './SlackConversationScope.ts'

const decodeAuthor = Schema.decodeUnknownSync(MessageAuthor)
const decodeConnectionId = Schema.decodeUnknownSync(PlatformConnectionId)
const decodeChannelId = Schema.decodeUnknownSync(PlatformChannelId)
const decodeConversationId = Schema.decodeUnknownSync(PlatformConversationId)
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeScopeId = Schema.decodeUnknownOption(PlatformScopeId)

const SlackChatRaw = Schema.Struct({
  channel: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.Union([Schema.String, Schema.Struct({ id: Schema.String })])),
  team_id: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(Schema.String),
  ts: Schema.optionalKey(Schema.String),
})
const decodeSlackChatRaw = Schema.decodeUnknownOption(SlackChatRaw)

export interface SlackInboundFile {
  readonly id?: string | undefined
  readonly name?: string | undefined
  readonly filetype?: string | undefined
  readonly mimetype?: string | undefined
}

/** Minimal Slack message event surface used for projection. */
export interface SlackInboundMessage {
  readonly teamId: string
  readonly channelId: string
  /** Message timestamp; doubles as the platform message id. */
  readonly ts: string
  /** Root thread timestamp when the message lives in a thread. */
  readonly threadTs?: string | undefined
  readonly userId: string
  readonly username?: string | undefined
  readonly displayName?: string | undefined
  readonly text: string
  readonly files?: ReadonlyArray<SlackInboundFile> | undefined
}

const unsupportedFileNotice = (file: SlackInboundFile): string => {
  const label =
    file.name === undefined || file.name.trim() === '' ? 'unnamed attachment' : file.name
  const detail = file.mimetype ?? file.filetype
  return `[Slack attachment unsupported: ${label}${detail ? ` (${detail})` : ''}]`
}

/**
 * Projects a Slack message event into a PlatformInput. Slack text is kept
 * verbatim, including `<@U...>` mentions, and the author mention stays in
 * verbatim `<@U...>` form. Image/file ingestion is deferred: attached files
 * are represented as a concise unsupported-attachment notice appended to the
 * text instead of being silently dropped.
 *
 * In `reply-in-channel`, the platform channel is the agent thread; in
 * `reply-in-thread`, the platform thread is the agent thread and the root
 * thread timestamp binds the conversation.
 */
export const projectSlackMessage = (
  connectionId: string,
  event: SlackInboundMessage,
): PlatformInput => {
  const location: SlackConversationLocation =
    event.threadTs === undefined || event.threadTs === ''
      ? { teamId: event.teamId, channelId: event.channelId }
      : { teamId: event.teamId, channelId: event.channelId, threadTs: event.threadTs }
  const channelId = decodeChannelId(slackChannelId(location))
  const conversationId = decodeConversationId(slackConversationId(location))
  const scopeId = Option.getOrUndefined(decodeScopeId(event.teamId))
  const notices = (event.files ?? []).map(unsupportedFileNotice)
  const text =
    notices.length === 0
      ? event.text
      : [event.text, ...notices].filter((part) => part.length > 0).join('\n')
  const bindingBase = {
    platform: 'slack' as const,
    connectionId: decodeConnectionId(connectionId),
    channelId,
    sourceMessageId: decodeMessageId(event.ts),
    conversationId,
  }
  const inThread = location.threadTs !== undefined
  return {
    binding: scopeId === undefined ? bindingBase : { ...bindingBase, scopeId },
    message: {
      source: 'user',
      author: decodeAuthor({
        platformUserId: event.userId,
        mention: `<@${event.userId}>`,
        username: event.username ?? null,
        displayName: event.displayName ?? null,
      }),
      content: { text, images: [] },
      platformMessageId: decodeMessageId(event.ts),
    },
    historySource: inThread ? 'thread' : 'channel',
    discordHistorySource: inThread ? 'thread' : 'channel',
  }
}

const teamIdFromRaw = (raw: Schema.Schema.Type<typeof SlackChatRaw>): string => {
  if (typeof raw.team_id === 'string' && raw.team_id !== '') return raw.team_id
  if (typeof raw.team === 'string' && raw.team !== '') return raw.team
  if (typeof raw.team === 'object' && raw.team !== null && raw.team.id !== '') return raw.team.id
  return ''
}

/**
 * Projects a Chat SDK Slack message into Friday's canonical scope. The adapter
 * thread id (`slack:{channel}:{threadTs}`, team-less) is reconciled explicitly
 * against the raw event: top-level messages collapse to the shared channel
 * root, threaded messages keep their root timestamp. Raw text stays verbatim
 * (including `<@U...>`), files stay deferred as unsupported notices, and the
 * author mention stays `<@U...>` — preserving Friday conversation semantics
 * instead of adopting the adapter identity model.
 */
export const projectSlackChatMessage = Effect.fn('projectSlackChatMessage')(function* (
  connectionId: string,
  thread: ChatSdkThreadProjectionSource,
  message: ChatSdkMessageProjectionSource,
) {
  const raw = Option.getOrUndefined(decodeSlackChatRaw(message.raw))
  const adapterLocation = decodeSlackAdapterThreadId(thread.id)
  const rawChannel = raw?.channel ?? adapterLocation?.channelId ?? ''
  const teamId = raw === undefined ? '' : teamIdFromRaw(raw)
  if (teamId === '' || rawChannel === '') {
    return yield* new ChatSdkCallbackError({
      operation: 'inbound-message',
      cause: new Error('Slack message is missing team or channel.'),
    })
  }
  // Explicit reconciliation: the adapter gives per-message threads for
  // top-level channel messages (`thread_ts ?? ts`); Friday collapses those to
  // the channel root so `reply-in-channel` stays channel-scoped. Threaded
  // messages keep `thread_ts` so `reply-in-thread` stays thread-scoped.
  const threadTs = raw?.thread_ts
  const location = reconcileSlackLocation({ teamId, channelId: rawChannel, threadTs })
  const verbatimText = raw?.text ?? message.text
  const files: ReadonlyArray<SlackInboundFile> = (message.attachments ?? []).map((attachment) => ({
    name: attachment.name,
    mimetype: attachment.mimeType,
  }))
  return projectSlackMessage(connectionId, {
    teamId: location.teamId,
    channelId: location.channelId,
    ts: message.id,
    threadTs: location.threadTs,
    userId: message.author.userId,
    username: message.author.userName,
    displayName: message.author.fullName,
    text: verbatimText,
    files,
  })
})
