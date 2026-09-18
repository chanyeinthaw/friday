import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { MessageAuthor, PlatformMessageId } from '@friday/contracts/conversation'
import {
  isSlackThreadTarget,
  PlatformMessageNotFoundError,
  PlatformTargetNotFoundError,
  type PlatformMessageGetQuery,
  type PlatformMessageGetResult,
  type PlatformMessagePostQuery,
  type PlatformMessagePostResult,
  type PlatformMessageQuery,
  type PlatformMessageRecord,
  type PlatformMessageSearchResult,
  type SlackQueryTarget,
} from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import type { Message } from 'chat'
import type { SlackAdapter } from '@chat-adapter/slack'
import { toSlackAdapterChannelId, toSlackAdapterThreadId } from './SlackConversationScope.ts'
import type { SlackResolvedChannelPolicy } from './SlackChannelAccess.ts'

/**
 * Safe native single-message limit for Slack posts. The chat.postMessage API
 * accepts far more, but 4,000 stays readable, keeps Block Kit fallback text
 * intact, and sits just above the 3,500 readability chunk size used for
 * normal publications. Posts are exactly one message, never chunked.
 */
export const SlackMaxPostLength = 4_000

const MaximumScanCount = 500
const decodeMessageId = Schema.decodeUnknownSync(PlatformMessageId)
const decodeMessageIdOption = Schema.decodeUnknownOption(PlatformMessageId)
const decodeAuthor = Schema.decodeUnknownSync(MessageAuthor)

const SlackSearchRaw = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
})
const decodeSlackSearchRaw = Schema.decodeUnknownOption(SlackSearchRaw)

/** Transport needed for explicit-target Slack reads and posts. */
export interface SlackMessageQueryAdapter extends Pick<
  SlackAdapter,
  'fetchMessages' | 'fetchChannelMessages' | 'fetchMessage' | 'postChannelMessage' | 'postMessage'
> {}

export interface SlackMessageQueryPolicy {
  readonly resolveChannelPolicy: (
    teamId: string,
    channelId: string,
  ) => SlackResolvedChannelPolicy | undefined
}

type SearchMessage = Message

const targetNotFound = () => new PlatformTargetNotFoundError({ kind: 'slack' })
const messageNotFound = (messageId: string) =>
  new PlatformMessageNotFoundError({ kind: 'slack', messageId })

const recordFrom = (message: SearchMessage): PlatformMessageRecord | undefined => {
  const raw = Option.getOrUndefined(decodeSlackSearchRaw(message.raw))
  // Direct get preserves bot authors: fall back to the bot id when the
  // transport reports no user. Search still skips bots before reaching here.
  const userId = raw?.user ?? raw?.bot_id ?? message.author.userId
  if (userId === undefined || userId === '') return undefined
  const text = raw?.text ?? message.text
  const threadTs = raw?.thread_ts
  return {
    id: decodeMessageId(message.id),
    author: decodeAuthor({
      platformUserId: userId,
      mention: `<@${userId}>`,
      username: userId,
      displayName: userId,
    }),
    text,
    sentAt: null,
    replyToMessageId: threadTs === undefined ? null : decodeMessageId(threadTs),
    attachments: [],
  }
}

const isBotMessage = (message: SearchMessage): boolean => {
  if (message.author.isBot === true || message.author.isMe === true) return true
  const raw = Option.getOrUndefined(decodeSlackSearchRaw(message.raw))
  return raw?.bot_id !== undefined || raw?.subtype === 'bot_message'
}

const messageMatches = (
  message: SearchMessage,
  needle: string | undefined,
  authorId: string | undefined,
): boolean => {
  const raw = Option.getOrUndefined(decodeSlackSearchRaw(message.raw))
  if (authorId !== undefined && (raw?.user ?? message.author.userId) !== authorId) return false
  if (needle === undefined) return true
  return (raw?.text ?? message.text).toLocaleLowerCase().includes(needle)
}

const compareTimestampPart = (a: string, b: string): number =>
  a.length !== b.length ? (a.length < b.length ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0

/**
 * Orders Slack message timestamps (`seconds.microseconds`) without float
 * precision loss. Returns negative when `a` is older than `b`.
 */
export const compareSlackMessageTs = (a: string, b: string): number => {
  const [aSeconds = '', aMicros = ''] = a.split('.')
  const [bSeconds = '', bMicros = ''] = b.split('.')
  return compareTimestampPart(aSeconds, bSeconds) || compareTimestampPart(aMicros, bMicros)
}

interface SlackResolvedTarget {
  readonly teamId: string
  readonly channelId: string
  readonly threadTs: string | undefined
  readonly adapterThreadId: string
  readonly adapterChannelId: string
}

/**
 * Resolves an explicit Slack target against the live admission policy.
 * Fail-closed: workspaces or channels outside the configured scope collapse
 * to a generic not-found that never exposes channel existence. The inbound
 * user allowlist is deliberately not applied: the invoking user/thread is
 * already admitted, and scope admission is the only read gate. Direct-message
 * channels (`D...`) are admitted exactly when the configured channel scope
 * admits them.
 */
const resolveSlackTarget = (
  target: SlackQueryTarget,
  policy: SlackMessageQueryPolicy,
): Effect.Effect<SlackResolvedTarget, PlatformTargetNotFoundError> =>
  Effect.gen(function* () {
    if (policy.resolveChannelPolicy(target.workspaceId, target.channelId) === undefined) {
      return yield* targetNotFound()
    }
    const location = { teamId: target.workspaceId, channelId: target.channelId }
    return {
      teamId: target.workspaceId,
      channelId: target.channelId,
      threadTs: target.threadTs,
      adapterThreadId: toSlackAdapterThreadId(
        target.threadTs === undefined ? location : { ...location, threadTs: target.threadTs },
      ),
      adapterChannelId: toSlackAdapterChannelId(location),
    }
  })

const readSearchPage = (
  adapter: SlackMessageQueryAdapter,
  inThread: boolean,
  threadId: string,
  channelId: string,
  limit: number,
  cursor: string | undefined,
) => {
  if (inThread) {
    return cursor === undefined
      ? adapter.fetchMessages(threadId, { limit })
      : adapter.fetchMessages(threadId, { limit, cursor })
  }
  return cursor === undefined
    ? adapter.fetchChannelMessages(channelId, { limit })
    : adapter.fetchChannelMessages(channelId, { limit, cursor })
}

/**
 * Searches Slack history with Friday's preserved semantics: a thread target
 * reads the native thread, a channel target reads the channel; bot messages
 * are skipped and text/author filters apply in memory. `before` is an
 * ordering boundary on message timestamps, not an API cursor: pagination
 * uses the transport's own page cursors while messages at or after `before`
 * are filtered in memory. Adapter thread ids derive explicitly from the
 * target so persistence never adopts the team-less transport identity.
 */
export const searchSlackMessages = Effect.fn('searchSlackMessages')(function* (
  adapter: SlackMessageQueryAdapter,
  query: PlatformMessageQuery,
  policy: SlackMessageQueryPolicy,
) {
  if (query.target.platform !== 'slack') return yield* targetNotFound()
  const resolved = yield* resolveSlackTarget(query.target, policy)
  const inThread = resolved.threadTs !== undefined
  const matches: Array<PlatformMessageRecord> = []
  const needle = query.query?.trim().toLocaleLowerCase()
  const beforeTs = query.before === undefined ? undefined : String(query.before)
  let cursor: string | undefined
  let scannedCount = 0
  let hasMore = true

  while (matches.length < query.limit && scannedCount < MaximumScanCount && hasMore) {
    const remaining = Math.min(100, MaximumScanCount - scannedCount)
    const page = yield* Effect.tryPromise({
      try: () =>
        readSearchPage(
          adapter,
          inThread,
          resolved.adapterThreadId,
          resolved.adapterChannelId,
          remaining,
          cursor,
        ),
      catch: (cause) => new ChatSdkPublicationError({ operation: 'publish', cause }),
    })
    scannedCount += page.messages.length
    for (const message of page.messages.toReversed()) {
      if (beforeTs !== undefined && compareSlackMessageTs(message.id, beforeTs) >= 0) continue
      if (isBotMessage(message)) continue
      if (!messageMatches(message, needle, query.authorId)) continue
      const record = recordFrom(message)
      if (record === undefined) continue
      matches.push(record)
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

/**
 * Fetches one Slack message through the transport's single-message endpoint.
 * Thread targets read within their native thread; channel targets read the
 * message as its own thread root (every channel message anchors a thread in
 * the Slack API). Slack permalink parsing is out of scope: a supplied URL is
 * rejected at the tool boundary, and reaching this layer with one collapses
 * to a generic not-found. Inaccessible and missing messages collapse to a
 * generic not-found, and bot authors are preserved (unlike history search,
 * which skips bots).
 */
export const getSlackMessage = Effect.fn('getSlackMessage')(function* (
  adapter: SlackMessageQueryAdapter,
  query: PlatformMessageGetQuery,
  policy: SlackMessageQueryPolicy,
) {
  const rawUrl = query.messageUrl?.trim()
  const requestedId = query.messageId === undefined ? '' : String(query.messageId)
  if (query.target === undefined || query.target.platform !== 'slack' || requestedId === '') {
    return yield* messageNotFound(rawUrl ?? requestedId)
  }
  const resolved = yield* resolveSlackTarget(query.target, policy).pipe(
    Effect.mapError(() => messageNotFound(requestedId)),
  )
  // Channel messages anchor their own thread root in conversations.replies,
  // so a channel target addresses the message through its own timestamp while
  // a thread target addresses it through the thread root.
  const threadId = isSlackThreadTarget(query.target)
    ? resolved.adapterThreadId
    : toSlackAdapterThreadId({
        teamId: resolved.teamId,
        channelId: resolved.channelId,
        threadTs: requestedId,
      })
  const message = yield* Effect.tryPromise({
    try: () => adapter.fetchMessage(threadId, requestedId),
    catch: () => messageNotFound(requestedId),
  })
  if (message === null || message.id !== requestedId) return yield* messageNotFound(requestedId)
  const record = recordFrom(message)
  if (record === undefined) return yield* messageNotFound(requestedId)
  return { message: record } satisfies PlatformMessageGetResult
})

const PostedMessageId = Schema.Struct({ id: Schema.optionalKey(Schema.String) })
const decodePostedMessageId = Schema.decodeUnknownOption(PostedMessageId)

/**
 * Posts exactly one text message to an explicit Slack target through the
 * current connection only. The target is policy-checked before posting; a
 * thread target posts as a thread reply, a channel target posts top-level.
 * Over-limit text is rejected rather than chunked: chunking would turn one
 * requested post into several platform messages. Returns the native message
 * timestamp id when the transport exposes one, otherwise a posted result
 * with a null id (never fabricated).
 */
export const postSlackMessage = Effect.fn('postSlackMessage')(function* (
  adapter: SlackMessageQueryAdapter,
  query: PlatformMessagePostQuery,
  policy: SlackMessageQueryPolicy,
) {
  if (query.target.platform !== 'slack') return yield* targetNotFound()
  if (query.text.trim() === '') {
    return yield* new ChatSdkPublicationError({ operation: 'post', cause: 'empty-text' })
  }
  if (query.text.length > SlackMaxPostLength) {
    return yield* new ChatSdkPublicationError({ operation: 'post', cause: 'over-limit' })
  }
  const resolved = yield* resolveSlackTarget(query.target, policy)
  const posted = yield* Effect.tryPromise({
    try: () =>
      isSlackThreadTarget(query.target)
        ? adapter.postMessage(resolved.adapterThreadId, query.text)
        : adapter.postChannelMessage(resolved.adapterChannelId, query.text),
    catch: (cause) => new ChatSdkPublicationError({ operation: 'post', cause }),
  })
  const id = Option.getOrUndefined(decodePostedMessageId(posted))?.id
  const messageId = Option.getOrUndefined(decodeMessageIdOption(id ?? ''))
  return { messageId: messageId ?? null } satisfies PlatformMessagePostResult
})
