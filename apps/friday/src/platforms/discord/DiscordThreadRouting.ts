import type { DiscordAdapter } from '@chat-adapter/discord'
import { PlatformConversationId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'
import type {
  PlatformThreadRouterContract,
  ThreadRouteDecideInput,
} from '../PlatformThreadRouter.ts'
import type { DiscordResolvedChannelPolicy } from './DiscordChannelAccess.ts'
import { isDiscordThread } from './DiscordConversationScope.ts'

const decodeConversationId = Schema.decodeSync(PlatformConversationId)

export interface DiscordThreadRouteAdapter extends Pick<
  DiscordAdapter,
  'decodeThreadId' | 'encodeThreadId'
> {
  /**
   * Explicit adaptive-routing thread creation that bypasses the
   * reply-in-channel suppression. Single attempt, no retry; callers fall back
   * to the parent channel on failure.
   */
  readonly createRoutedDiscordThread: (
    channelId: string,
    messageId: string,
  ) => Promise<{ readonly id: string; readonly name: string }>
}

export interface DiscordThreadRouteOptions {
  readonly discord: DiscordThreadRouteAdapter
  readonly decide: PlatformThreadRouterContract['decide']
  readonly resolveChannelPolicy: (
    guildId: string,
    channelId: string,
  ) => DiscordResolvedChannelPolicy | undefined
}

/**
 * Rebinds a normalized input to a newly created native thread. The source
 * message, channel identity, attribution, and bounded parent context are
 * preserved; only the conversation binding moves to the thread. The target
 * reports `thread` history so later reads resolve from the native thread.
 */
export const rebindToNativeThread = (
  input: PlatformInput,
  conversationId: string,
): PlatformInput => ({
  ...input,
  binding: {
    ...input.binding,
    conversationId: decodeConversationId(conversationId),
  },
  discordHistorySource: 'thread',
})

const decideInputFrom = (input: PlatformInput): ThreadRouteDecideInput => ({
  text: input.message.content.text,
  context: input.initialContext ?? [],
})

/**
 * Builds the per-connection adaptive routing function used after normalized
 * projection and context enrichment but before `ChannelTurns.accept`. The
 * function never fails: ineligible messages return unchanged, while decision
 * (model/auth/timeout/validation), decode, and native-thread-creation
 * failures log and return the parent-channel input so normal processing
 * continues. It never re-ingests through Chat SDK and never retries native
 * thread creation.
 *
 * Native creation is a single awaited attempt with no client-side timeout.
 * The Discord POST is non-abortable server-side: aborting the wait cannot
 * prevent the thread from being created, so a timeout fallback would answer
 * in the parent while the same POST later creates an orphaned native thread.
 * Routing therefore waits for the single creation result before continuing;
 * a slow Discord API delays the reply rather than orphaning a thread.
 */
export const makeDiscordThreadRoute =
  (options: DiscordThreadRouteOptions) =>
  (input: PlatformInput): Effect.Effect<PlatformInput> =>
    Effect.gen(function* () {
      if (input.binding.platform !== 'discord') return input
      if (input.discordHistorySource === 'thread') return input
      const location = yield* Effect.try({
        try: () => options.discord.decodeThreadId(String(input.binding.conversationId)),
        catch: () => 'decode-failed' as const,
      }).pipe(Effect.orElseSucceed(() => null))
      if (location === null) return input
      if (isDiscordThread(location)) return input
      const policy = options.resolveChannelPolicy(location.guildId, location.channelId)
      if (policy === undefined || policy.replyMode !== 'reply-in-channel') return input
      const decision = yield* options.decide(decideInputFrom(input)).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning('thread.route.decision-failed').pipe(
            Effect.annotateLogs({
              component: 'discord',
              channelId: location.channelId,
              conversationId: String(input.binding.conversationId),
              cause: String(cause),
            }),
          ),
        ),
        Effect.orElseSucceed(() => null),
      )
      if (decision === null) return input
      if (decision.decision === 'keep-channel') {
        yield* Effect.logDebug('thread.route.kept').pipe(
          Effect.annotateLogs({
            component: 'discord',
            channelId: location.channelId,
            conversationId: String(input.binding.conversationId),
          }),
        )
        return input
      }
      const platformMessageId = input.message.platformMessageId ?? input.binding.sourceMessageId
      if (platformMessageId === undefined) {
        yield* Effect.logWarning('thread.route.missing-message').pipe(
          Effect.annotateLogs({
            component: 'discord',
            channelId: location.channelId,
            conversationId: String(input.binding.conversationId),
          }),
        )
        return input
      }
      // Single awaited native creation attempt with no client-side timeout and
      // no retry. Failures log and fall back to the parent input. Waiting for
      // the single result (instead of racing a timeout) guarantees a late
      // Discord success cannot become an orphaned thread while Friday answers
      // in the parent.
      const created = yield* Effect.tryPromise({
        try: () =>
          options.discord.createRoutedDiscordThread(location.channelId, String(platformMessageId)),
        catch: (cause) => ({ cause }),
      }).pipe(
        Effect.tapError(({ cause }) =>
          Effect.logWarning('thread.route.create-failed').pipe(
            Effect.annotateLogs({
              component: 'discord',
              channelId: location.channelId,
              platformMessageId: String(platformMessageId),
              cause: String(cause),
            }),
          ),
        ),
        Effect.orElseSucceed(() => null),
      )
      if (created === null) return input
      const conversationId = options.discord.encodeThreadId({
        guildId: location.guildId,
        channelId: location.channelId,
        threadId: created.id,
      })
      const rebound = rebindToNativeThread(input, conversationId)
      yield* Effect.logInfo('thread.routed').pipe(
        Effect.annotateLogs({
          component: 'discord',
          channelId: location.channelId,
          parentConversationId: String(input.binding.conversationId),
          conversationId,
          reason: decision.reason,
        }),
      )
      return rebound
    })
