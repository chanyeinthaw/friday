import type { DiscordAdapter } from '@chat-adapter/discord'
import type { Message } from 'chat'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { PlatformMessageId } from '@friday/contracts/conversation'
import {
  isDiscordThreadTarget,
  PlatformMessageNotFoundError,
  PlatformTargetNotFoundError,
  type DiscordQueryTarget,
  type PlatformMessageGetQuery,
  type PlatformMessageGetResult,
  type PlatformMessagePostQuery,
  type PlatformMessagePostResult,
  type PlatformMessageQuery,
  type PlatformMessageRecord,
  type PlatformMessageSearchResult,
} from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import { projectChatSdkContextMessage } from '../chat-sdk/MessageProjection.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'
import { discordChannelConversationId } from './DiscordConversationScope.ts'

/** Native Discord message limit; posts are exactly one message, never chunked. */
export const DiscordMaxPostLength = 2_000

const MaximumScanCount = 500
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeMessageIdOption = Schema.decodeUnknownOption(PlatformMessageId)

/** Transport needed for explicit-target reads and single-message posts. */
export interface DiscordMessageQueryAdapter extends Pick<
  DiscordAdapter,
  | 'decodeThreadId'
  | 'encodeThreadId'
  | 'fetchChannelInfo'
  | 'fetchMessages'
  | 'postChannelMessage'
  | 'postMessage'
> {
  readonly fetchDirectMessage: (channelId: string, messageId: string) => Promise<Message>
}

export interface DiscordMessageQueryPolicy {
  readonly resolveChannelPolicy: (
    guildId: string,
    channelId: string,
  ) => DiscordResolvedChannelPolicy | undefined
}

const DiscordThreadChannel = Schema.Struct({
  id: Schema.String,
  parent_id: Schema.String,
  type: Schema.Literals([10, 11, 12]),
})
const decodeDiscordThreadChannel = Schema.decodeUnknownOption(DiscordThreadChannel)

const targetNotFound = () => new PlatformTargetNotFoundError({ kind: 'discord' })
const messageNotFound = (messageId: string) =>
  new PlatformMessageNotFoundError({ kind: 'discord', messageId })

const recordFrom = (message: Message): PlatformMessageRecord => {
  const context = projectChatSdkContextMessage('discord', message)
  return {
    id: context.platformMessageId ?? decodeMessageId(message.id),
    author: context.author,
    text: context.content.text,
    sentAt: message.metadata.dateSent.toISOString(),
    replyToMessageId: message.replyTo ? decodeMessageId(message.replyTo.id) : null,
    attachments: context.content.images,
  }
}

interface DiscordResolvedTarget {
  /** Guild from the explicit target. */
  readonly guildId: string
  /** Effective channel for policy gating: the parent channel for threads. */
  readonly channelId: string
  /** Encoded conversation address for history reads and thread posts. */
  readonly source: string
  /** Raw channel id for direct single-message fetches. */
  readonly fetchChannelId: string
}

/**
 * Resolves an explicit Discord target against the live admission policy.
 * Threads inherit their parent-channel policy: the parent resolves through
 * channel info, and a supplied parent hint must agree with it. Direct
 * messages (`@me`) are never valid query targets. Fail-closed: unknown,
 * disabled, unadmitted, inaccessible, and missing targets collapse to a
 * generic not-found that never exposes channel existence. The inbound user
 * allowlist is deliberately not applied: the invoking user/thread is already
 * admitted, and scope admission is the only read gate.
 */
const resolveDiscordTarget = Effect.fn('resolveDiscordTarget')(function* (
  discord: DiscordMessageQueryAdapter,
  target: DiscordQueryTarget,
  policy: DiscordMessageQueryPolicy,
) {
  if (target.guildId === '@me') return yield* targetNotFound()
  if (isDiscordThreadTarget(target)) {
    const threadId = target.threadId
    const info = yield* Effect.tryPromise({
      try: () =>
        discord.fetchChannelInfo(
          discord.encodeThreadId({ guildId: target.guildId, channelId: threadId }),
        ),
      catch: () => targetNotFound(),
    })
    const thread = Option.getOrUndefined(decodeDiscordThreadChannel(info.metadata.raw))
    if (thread === undefined) return yield* targetNotFound()
    if (target.channelId !== undefined && target.channelId !== thread.parent_id) {
      return yield* targetNotFound()
    }
    if (policy.resolveChannelPolicy(target.guildId, thread.parent_id) === undefined) {
      return yield* targetNotFound()
    }
    const source = yield* Effect.try({
      try: () =>
        discord.encodeThreadId({
          guildId: target.guildId,
          channelId: thread.parent_id,
          threadId,
        }),
      catch: () => targetNotFound(),
    })
    return {
      guildId: target.guildId,
      channelId: thread.parent_id,
      source,
      fetchChannelId: threadId,
    } satisfies DiscordResolvedTarget
  }
  const channelId = target.channelId
  if (channelId === undefined) return yield* targetNotFound()
  if (policy.resolveChannelPolicy(target.guildId, channelId) === undefined) {
    return yield* targetNotFound()
  }
  const source = yield* Effect.try({
    try: () => discordChannelConversationId(discord, { guildId: target.guildId, channelId }),
    catch: () => targetNotFound(),
  })
  return {
    guildId: target.guildId,
    channelId,
    source,
    fetchChannelId: channelId,
  } satisfies DiscordResolvedTarget
})

export const searchDiscordMessages = Effect.fn('searchDiscordMessages')(function* (
  discord: DiscordMessageQueryAdapter,
  query: PlatformMessageQuery,
  policy: DiscordMessageQueryPolicy,
) {
  if (query.target.platform !== 'discord') return yield* targetNotFound()
  const resolved = yield* resolveDiscordTarget(discord, query.target, policy)
  const matches: Array<PlatformMessageRecord> = []
  const needle = query.query?.trim().toLocaleLowerCase()
  let cursor = query.before === undefined ? undefined : String(query.before)
  let scannedCount = 0
  let hasMore = true

  while (matches.length < query.limit && scannedCount < MaximumScanCount && hasMore) {
    const remaining = Math.min(100, MaximumScanCount - scannedCount)
    const page = yield* Effect.tryPromise({
      try: () =>
        discord.fetchMessages(
          resolved.source,
          cursor === undefined ? { limit: remaining } : { limit: remaining, cursor },
        ),
      catch: (cause) => new ChatSdkPublicationError({ operation: 'publish', cause }),
    })
    scannedCount += page.messages.length
    for (const message of page.messages.toReversed()) {
      if (message.author.isBot || message.author.isMe) continue
      if (query.authorId !== undefined && message.author.userId !== query.authorId) continue
      if (needle !== undefined && !message.text.toLocaleLowerCase().includes(needle)) continue
      matches.push(recordFrom(message))
      if (matches.length >= query.limit) break
    }
    cursor = page.nextCursor
    hasMore = page.nextCursor !== undefined
  }

  return {
    messages: matches.toReversed(),
    scannedCount,
    truncated: hasMore || scannedCount >= MaximumScanCount,
  } satisfies PlatformMessageSearchResult
})

interface DiscordMessageUrl {
  readonly guildId: string
  readonly channelId: string
  readonly messageId: string
}

const parseDiscordMessageUrl = (
  rawUrl: string,
): Effect.Effect<DiscordMessageUrl, PlatformMessageNotFoundError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(rawUrl.trim()),
      catch: () => messageNotFound(rawUrl.trim()),
    })
    const host = url.hostname.toLocaleLowerCase()
    if (!host.endsWith('discord.com') && !host.endsWith('discordapp.com')) {
      return yield* messageNotFound(rawUrl.trim())
    }
    const segments = url.pathname.split('/')
    if (
      segments.length !== 5 ||
      segments[1] !== 'channels' ||
      segments[2] === undefined ||
      segments[2] === '' ||
      segments[3] === undefined ||
      segments[3] === '' ||
      segments[4] === undefined ||
      segments[4] === ''
    ) {
      return yield* messageNotFound(rawUrl.trim())
    }
    return { guildId: segments[2], channelId: segments[3], messageId: segments[4] }
  })

/**
 * Fetches one Discord message through the direct single-message endpoint. A
 * bare message id resolves against the required explicit target; a message
 * URL may derive its target from the URL, and a supplied target must agree
 * with it (same guild, same channel or thread). URL targets gate against the
 * live channel policy with thread URLs inheriting their parent channel
 * policy. Direct messages (`@me`) are rejected. Inaccessible and missing
 * targets collapse to a generic not-found, and bot authors are preserved
 * (unlike history search, which skips bots).
 */
export const getDiscordMessage = Effect.fn('getDiscordMessage')(function* (
  discord: DiscordMessageQueryAdapter,
  query: PlatformMessageGetQuery,
  policy: DiscordMessageQueryPolicy,
) {
  const rawUrl = query.messageUrl?.trim()
  if (rawUrl !== undefined && rawUrl !== '') {
    // A URL plus an id is ambiguous; fail closed instead of guessing.
    if (query.messageId !== undefined) return yield* messageNotFound(rawUrl)
    return yield* getDiscordMessageByUrl(discord, query, policy, rawUrl)
  }
  if (query.messageId !== undefined) {
    return yield* getDiscordMessageById(discord, query, policy)
  }
  return yield* messageNotFound('')
})

const getDiscordMessageById = Effect.fn('getDiscordMessageById')(function* (
  discord: DiscordMessageQueryAdapter,
  query: PlatformMessageGetQuery,
  policy: DiscordMessageQueryPolicy,
) {
  const requestedId = String(query.messageId)
  if (query.target === undefined || query.target.platform !== 'discord') {
    return yield* messageNotFound(requestedId)
  }
  const resolved = yield* resolveDiscordTarget(discord, query.target, policy).pipe(
    Effect.mapError(() => messageNotFound(requestedId)),
  )
  const message = yield* Effect.tryPromise({
    try: () => discord.fetchDirectMessage(resolved.fetchChannelId, requestedId),
    catch: () => messageNotFound(requestedId),
  })
  return { message: recordFrom(message) } satisfies PlatformMessageGetResult
})

const getDiscordMessageByUrl = Effect.fn('getDiscordMessageByUrl')(function* (
  discord: DiscordMessageQueryAdapter,
  query: PlatformMessageGetQuery,
  policy: DiscordMessageQueryPolicy,
  rawUrl: string,
) {
  const parsed = yield* parseDiscordMessageUrl(rawUrl)
  if (parsed.guildId === '@me') return yield* messageNotFound(parsed.messageId)
  const decodedId = Option.getOrUndefined(decodeMessageIdOption(parsed.messageId))
  if (decodedId === undefined) return yield* messageNotFound(parsed.messageId)
  const target = query.target
  if (target !== undefined) {
    // An explicit target must agree with the URL-derived location: same
    // guild, same channel or thread. Disagreement collapses to not-found.
    if (target.platform !== 'discord' || target.guildId !== parsed.guildId) {
      return yield* messageNotFound(parsed.messageId)
    }
    const agrees = isDiscordThreadTarget(target)
      ? target.threadId === parsed.channelId
      : target.channelId === parsed.channelId
    if (!agrees) return yield* messageNotFound(parsed.messageId)
  }
  // Thread URLs inherit their parent channel policy: only thread-typed
  // channels resolve through `parent_id`, everything else gates on the URL
  // channel itself.
  const info = yield* Effect.tryPromise({
    try: () =>
      discord.fetchChannelInfo(
        discord.encodeThreadId({ guildId: parsed.guildId, channelId: parsed.channelId }),
      ),
    catch: () => messageNotFound(parsed.messageId),
  })
  const thread = Option.getOrUndefined(decodeDiscordThreadChannel(info.metadata.raw))
  const effectiveChannelId = thread === undefined ? parsed.channelId : thread.parent_id
  if (target !== undefined && isDiscordThreadTarget(target)) {
    if (thread === undefined || target.threadId !== parsed.channelId) {
      return yield* messageNotFound(parsed.messageId)
    }
    if (target.channelId !== undefined && target.channelId !== thread.parent_id) {
      return yield* messageNotFound(parsed.messageId)
    }
  }
  if (policy.resolveChannelPolicy(parsed.guildId, effectiveChannelId) === undefined) {
    return yield* messageNotFound(parsed.messageId)
  }
  const message = yield* Effect.tryPromise({
    try: () => discord.fetchDirectMessage(parsed.channelId, String(decodedId)),
    catch: () => messageNotFound(parsed.messageId),
  })
  return { message: recordFrom(message) } satisfies PlatformMessageGetResult
})

const PostedMessageId = Schema.Struct({ id: Schema.optionalKey(Schema.String) })
const decodePostedMessageId = Schema.decodeUnknownOption(PostedMessageId)

/**
 * Posts exactly one text message to an explicit Discord target through the
 * current connection only. The target is policy-checked before posting;
 * thread targets resolve through channel info so the parent-channel policy
 * applies. Over-limit text is rejected rather than chunked: chunking would
 * turn one requested post into several platform messages. Returns the native
 * message id when the transport exposes one, otherwise a posted result with
 * a null id (never fabricated).
 */
export const postDiscordMessage = Effect.fn('postDiscordMessage')(function* (
  discord: DiscordMessageQueryAdapter,
  query: PlatformMessagePostQuery,
  policy: DiscordMessageQueryPolicy,
) {
  if (query.target.platform !== 'discord') return yield* targetNotFound()
  if (query.text.trim() === '') {
    return yield* new ChatSdkPublicationError({ operation: 'post', cause: 'empty-text' })
  }
  if (query.text.length > DiscordMaxPostLength) {
    return yield* new ChatSdkPublicationError({ operation: 'post', cause: 'over-limit' })
  }
  const resolved = yield* resolveDiscordTarget(discord, query.target, policy)
  const posted = yield* Effect.tryPromise({
    try: () =>
      isDiscordThreadTarget(query.target)
        ? discord.postMessage(resolved.source, query.text)
        : discord.postChannelMessage(
            discord.encodeThreadId({ guildId: resolved.guildId, channelId: resolved.channelId }),
            query.text,
          ),
    catch: (cause) => new ChatSdkPublicationError({ operation: 'post', cause }),
  })
  const id = Option.getOrUndefined(decodePostedMessageId(posted))?.id
  const messageId = Option.getOrUndefined(decodeMessageIdOption(id ?? ''))
  return { messageId: messageId ?? null } satisfies PlatformMessagePostResult
})
