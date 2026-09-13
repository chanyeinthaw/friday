import { PlatformConversationId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { platformHistorySource } from '../PlatformAdapter.ts'
import type {
  PlatformThreadRouterContract,
  ThreadRouteDecideInput,
} from '../PlatformThreadRouter.ts'
import type { SlackResolvedChannelPolicy } from './SlackChannelAccess.ts'
import { isSlackDirectMessageChannel } from './SlackChannelAccess.ts'
import {
  decodeSlackConversationId,
  isSlackThread,
  slackConversationId,
} from './SlackConversationScope.ts'

const decodeConversationId = Schema.decodeSync(PlatformConversationId)

export interface SlackThreadRouteOptions {
  readonly decide: PlatformThreadRouterContract['decide']
  readonly resolveChannelPolicy: (
    teamId: string,
    channelId: string,
  ) => SlackResolvedChannelPolicy | undefined
}

/**
 * Rebinds a normalized input to the platform thread rooted at the source
 * message. Slack threads are created implicitly by replying with `thread_ts`,
 * so routing needs no native creation call: the source timestamp becomes the
 * thread root and later publishes target it. The target reports `thread`
 * history so later reads resolve from the thread.
 */
export const rebindToSlackThread = (input: PlatformInput, threadTs: string): PlatformInput => {
  const location = decodeSlackConversationId(String(input.binding.conversationId))
  const conversationId =
    location === undefined
      ? String(input.binding.conversationId)
      : slackConversationId({ teamId: location.teamId, channelId: location.channelId, threadTs })
  return {
    ...input,
    binding: {
      ...input.binding,
      conversationId: decodeConversationId(conversationId),
    },
    historySource: 'thread',
    discordHistorySource: 'thread',
  }
}

const decideInputFrom = (input: PlatformInput): ThreadRouteDecideInput => ({
  text: input.message.content.text,
  context: input.initialContext ?? [],
})

/**
 * Builds the per-connection routing function used after normalized
 * projection and context enrichment but before `ChannelTurns.accept`. The
 * function never fails: ineligible messages return unchanged, while decision
 * failures log and return the parent-channel input so normal processing
 * continues. It never re-ingests and never calls the Slack API.
 *
 * Two cases rebind a top-level channel message to its crux thread:
 * - `reply-in-thread` always binds a fresh invocation to the thread rooted
 *   at the source message timestamp, so replies publish with that
 *   `thread_ts`. Channel roots, existing threads, and DMs are preserved.
 * - `reply-in-channel` adaptively rebinds only when the router decides a
 *   thread is beneficial; otherwise the channel root is preserved.
 */
export const makeSlackThreadRoute =
  (options: SlackThreadRouteOptions) =>
  (input: PlatformInput): Effect.Effect<PlatformInput> =>
    Effect.gen(function* () {
      if (input.binding.platform !== 'slack') return input
      if (platformHistorySource(input) === 'thread') return input
      const location = decodeSlackConversationId(String(input.binding.conversationId))
      if (location === undefined) return input
      if (isSlackThread(location)) return input
      // DMs stay channel-scoped in every mode; only channel conversations
      // bind fresh invocations to a crux thread.
      if (isSlackDirectMessageChannel(location.channelId)) return input
      const policy = options.resolveChannelPolicy(location.teamId, location.channelId)
      if (policy === undefined) return input
      if (policy.replyMode === 'reply-in-thread') {
        const platformMessageId = input.message.platformMessageId ?? input.binding.sourceMessageId
        if (platformMessageId === undefined) {
          yield* Effect.logWarning('thread.route.missing-message').pipe(
            Effect.annotateLogs({
              component: 'slack',
              channelId: location.channelId,
              conversationId: String(input.binding.conversationId),
            }),
          )
          return input
        }
        const rebound = rebindToSlackThread(input, String(platformMessageId))
        yield* Effect.logInfo('thread.bound').pipe(
          Effect.annotateLogs({
            component: 'slack',
            channelId: location.channelId,
            parentConversationId: String(input.binding.conversationId),
            conversationId: String(rebound.binding.conversationId),
            reason: 'reply-in-thread',
          }),
        )
        return rebound
      }
      if (policy.replyMode !== 'reply-in-channel') return input
      const decision = yield* options.decide(decideInputFrom(input)).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning('thread.route.decision-failed').pipe(
            Effect.annotateLogs({
              component: 'slack',
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
            component: 'slack',
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
            component: 'slack',
            channelId: location.channelId,
            conversationId: String(input.binding.conversationId),
          }),
        )
        return input
      }
      const rebound = rebindToSlackThread(input, String(platformMessageId))
      yield* Effect.logInfo('thread.routed').pipe(
        Effect.annotateLogs({
          component: 'slack',
          channelId: location.channelId,
          parentConversationId: String(input.binding.conversationId),
          conversationId: String(rebound.binding.conversationId),
          reason: decision.reason,
        }),
      )
      return rebound
    })
