import { Chat } from 'chat'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { AppConfig } from '../../config/AppConfigLive.ts'
import { findSlackConnection, type SlackPlatformConfig } from '../../config/AppConfig.ts'
import { PlatformIngestion } from '../PlatformIngestion.ts'
import { PlatformRegistry } from '../PlatformRegistry.ts'
import { PlatformThreadRouter } from '../PlatformThreadRouter.ts'
import { isAllowedByPolicy } from '../chat-sdk/AccessPolicy.ts'
import { ChatSdkLifecycleError } from '../chat-sdk/Errors.ts'
import { admitPlatformMessage } from '../PlatformAdmission.ts'
import { startChatSdkLifecycle } from '../chat-sdk/ChatSdkLifecycle.ts'
import { makeSqliteChatStateAdapter } from '../chat-sdk/SqliteChatStateAdapter.ts'
import {
  containsDirectMention,
  isSlackDirectMessageChannel,
  resolveSlackChannelPolicy,
  shouldInvokeSlack,
  type SlackConnectionPolicies,
  type SlackPolicyProvider,
} from './SlackChannelAccess.ts'
import { makeSlackThreadBootstrap } from './SlackChannelBootstrap.ts'
import { loadSlackInitialContext, shouldLoadSlackContext } from './SlackInitialContext.ts'
import { projectSlackChatMessage } from './SlackMessageProjection.ts'
import { makeSlackPlatform } from './SlackPlatform.ts'
import { makeSlackThreadRoute } from './SlackThreadRouting.ts'
import { FridaySlackAdapter } from './FridaySlackAdapter.ts'
import { decodeSlackConversationId } from './SlackConversationScope.ts'

/** Bounded in-memory dedup for socket redeliveries of the same platform message. */
export const makeMessageDedup = (capacity: number) => {
  const seen = new Set<string>()
  const order: Array<string> = []
  return {
    hasOrAdd: (key: string): boolean => {
      if (seen.has(key)) return true
      seen.add(key)
      order.push(key)
      while (order.length > capacity) {
        const oldest = order.shift()
        if (oldest !== undefined) seen.delete(oldest)
      }
      return false
    },
  }
}

const SlackAuthTest = Schema.Struct({ team_id: Schema.optionalKey(Schema.String) })
const decodeSlackAuthTest = Schema.decodeUnknownOption(SlackAuthTest)

type SlackSocketConfig = Extract<SlackPlatformConfig, { readonly mode: 'socket' }>

export const makeSlackConnectionRuntime = Effect.fn('makeSlackConnectionRuntime')(function* (
  slackConfig: SlackSocketConfig,
) {
  const platforms = yield* PlatformRegistry
  const ingestion = yield* PlatformIngestion
  const threadRouter = yield* PlatformThreadRouter
  const config = yield* AppConfig
  const state = yield* makeSqliteChatStateAdapter(`friday:${slackConfig.connectionId}`)
  // Reloadable policies are read from the in-memory snapshot on every
  // message; the Slack resources below never observe partial swaps.
  const policies: SlackPolicyProvider = () =>
    Option.map(
      findSlackConnection(config.current(), slackConfig.connectionId),
      (connection): SlackConnectionPolicies =>
        connection.mode === 'socket'
          ? {
              access: connection.access,
              defaultReplyMode: connection.defaultReplyMode,
              channels: connection.channels,
            }
          : {
              access: connection.access,
              defaultReplyMode: connection.defaultReplyMode,
              channels: connection.channels,
            },
    )
  const currentPolicies = (): SlackConnectionPolicies =>
    Option.getOrElse(policies(), (): SlackConnectionPolicies => ({
      access: {
        users: { mode: 'deny', ids: [] },
        channels: { mode: 'deny', ids: [] },
        workspaces: { mode: 'deny', ids: [] },
      },
      defaultReplyMode: 'reply-in-thread',
      channels: [],
    }))
  const resolveChannelPolicy = (teamId: string, channelId: string) =>
    Option.getOrUndefined(resolveSlackChannelPolicy(currentPolicies(), teamId, channelId))
  const seenMessages = makeMessageDedup(2000)
  const slack = yield* Effect.try({
    try: () =>
      new FridaySlackAdapter({
        botToken: String(slackConfig.credentials.botToken),
        appToken: String(slackConfig.credentials.appToken),
        resolveChannelPolicy,
        suggestedPrompts: {
          prompts: [
            { title: 'What can you do?', message: 'What can you do?' },
            {
              title: 'Summarize this channel',
              message: 'Summarize recent messages in this channel',
            },
          ],
          title: 'Try asking Friday',
        },
      }),
    catch: (cause) => new ChatSdkLifecycleError({ operation: 'create-adapter', cause }),
  })
  // Single-workspace binding for explicit query/post targets. The bot token
  // belongs to exactly one workspace; `auth.test` returns its team id from
  // Slack rather than trusting model input or the invoking thread's team.
  // Unresolved bindings deny all explicit targets fail-closed (empty can
  // never match a validated non-empty target workspace) while normal
  // conversation-bound publishing keeps working.
  const workspaceId = yield* Effect.tryPromise({
    try: () => slack.webClient.auth.test(),
    catch: (cause) => new ChatSdkLifecycleError({ operation: 'create-adapter', cause }),
  }).pipe(
    Effect.flatMap((result) => {
      const teamId = Option.getOrUndefined(decodeSlackAuthTest(result))?.team_id
      return teamId !== undefined && teamId !== ''
        ? Effect.succeed(teamId)
        : Effect.fail(
            new ChatSdkLifecycleError({ operation: 'create-adapter', cause: 'missing-team' }),
          )
    }),
    Effect.catch((cause) =>
      Effect.logWarning('slack.workspace.unresolved').pipe(
        Effect.annotateLogs({
          component: 'slack',
          connectionId: String(slackConfig.connectionId),
          cause: String(cause),
        }),
        Effect.as(''),
      ),
    ),
  )
  const chat = yield* Effect.try({
    try: () =>
      new Chat({
        userName: 'Friday',
        // SAFETY: Chat SDK 4.40 generic Adapter declaration is not exact-optional compatible with its concrete SlackAdapter declaration under this repo TS settings.
        adapters: { slack: slack as never },
        state,
        concurrency: 'concurrent',
      }),
    catch: (cause) => new ChatSdkLifecycleError({ operation: 'create-chat', cause }),
  })
  const bootstrap = yield* makeSlackThreadBootstrap({
    adapter: slack,
    model: () => config.current().models.primary,
  })
  // Adaptive thread routing runs after projection and context
  // enrichment but before the agent turn. It rebinds top-level
  // reply-in-channel messages to a new platform thread without
  // re-ingesting through Chat SDK; failures return the parent input.
  const routeThread = makeSlackThreadRoute({
    decide: (decideInput) => threadRouter.decide(decideInput),
    resolveChannelPolicy,
  })
  // Explicit targets gate against the connection's bound workspace first,
  // then the live workspace/channel policy snapshot; thread targets inherit
  // their channel policy. The inbound user allowlist stays out of reads and
  // posts: the invoking thread is already admitted.
  const agentPlatform = yield* makeSlackPlatform(slackConfig.connectionId, slack, {
    workspaceId,
    resolveChannelPolicy,
  })
  yield* platforms.register(agentPlatform)
  // Agent lifecycle observability: these never create Friday threads or
  // publish. Friday never sets session working status and never cancels
  // a Pi turn from Slack; a stopped event only logs. Title changes,
  // assistant context, Home opens, and active-view context log without
  // changing persistence, steering, tasks, routing, access, history, or
  // channel-scoped workspaces.
  chat.onAgentSessionStopped((event) => {
    void Effect.runPromise(
      Effect.logInfo('slack.agent-session.stopped').pipe(
        Effect.annotateLogs({
          component: 'slack',
          connectionId: String(slackConfig.connectionId),
          threadId: event.threadId,
        }),
      ),
    )
  })
  chat.onAgentSessionTitleChanged((event) => {
    void Effect.runPromise(
      Effect.logInfo('slack.agent-session.title-changed').pipe(
        Effect.annotateLogs({
          component: 'slack',
          connectionId: String(slackConfig.connectionId),
          threadId: event.threadId,
          title: event.title,
        }),
      ),
    )
  })
  chat.onAssistantThreadStarted((event) => {
    void Effect.runPromise(
      Effect.logDebug('slack.assistant-thread.started').pipe(
        Effect.annotateLogs({
          component: 'slack',
          connectionId: String(slackConfig.connectionId),
          threadId: event.threadId,
        }),
      ),
    )
  })
  chat.onAssistantContextChanged((event) => {
    void Effect.runPromise(
      Effect.logDebug('slack.assistant-context.changed').pipe(
        Effect.annotateLogs({
          component: 'slack',
          connectionId: String(slackConfig.connectionId),
          threadId: event.threadId,
        }),
      ),
    )
  })
  chat.onAppHomeOpened((event) => {
    void Effect.runPromise(
      Effect.logDebug('slack.app-home.opened').pipe(
        Effect.annotateLogs({
          component: 'slack',
          connectionId: String(slackConfig.connectionId),
          tab: event.tab ?? '',
        }),
      ),
    )
  })
  chat.onAppContextChanged((event) => {
    void Effect.runPromise(
      Effect.logDebug('slack.app-context.changed').pipe(
        Effect.annotateLogs({
          component: 'slack',
          connectionId: String(slackConfig.connectionId),
          entityCount: event.entities.length,
        }),
      ),
    )
  })
  // No `shouldHandleMessage` here: the adapter preflight
  // (`FridaySlackAdapter`) already drops unknown/disabled workspaces,
  // channels, and denied users before upstream Chat state, and the
  // shared admission below is the authoritative gate after projection.
  // Keeping a second full invocation check here would duplicate policy,
  // binding, dedup, and logging orchestration that `PlatformAdmission`
  // now owns. The catch-all pattern below only fixes delivery: Chat
  // drops unmentioned chatter in unsubscribed threads before any
  // handler runs, so without it `all-messages` channels would never
  // see the messages the mode is meant to admit. Matched messages flow
  // through the same admission pipeline as `subscribed-message`; the
  // invocation decision stays in the shared hooks.
  yield* startChatSdkLifecycle({
    connectionId: String(slackConfig.connectionId),
    chat,
    normalizeInboundMessage: (thread, message) =>
      projectSlackChatMessage(String(slackConfig.connectionId), thread, message),
    catchAll: { pattern: /[\s\S]*/, kind: 'subscribed-message' },
    onInboundMessage: (input, kind) =>
      admitPlatformMessage(
        input,
        kind,
        {
          platform: 'slack',
          connectionId: String(slackConfig.connectionId),
          // Explicit reconciliation first so policy resolves from the
          // canonical team/channel while the message stays in its
          // thread.
          resolvePolicy: (canonical) => {
            const location = decodeSlackConversationId(String(canonical.binding.conversationId))
            if (location === undefined) return undefined
            return resolveChannelPolicy(location.teamId, location.channelId)
          },
          isUserAdmitted: (canonical, policy) =>
            canonical.message.author !== undefined &&
            isAllowedByPolicy(String(canonical.message.author.platformUserId), policy.users),
          // Socket redeliveries of the same platform message collapse
          // here; the adapter already dedupes event deliveries by
          // event_id. The key derives from canonical input only so the
          // shared layer never parses raw events.
          checkDuplicate: (canonical) => {
            const location = decodeSlackConversationId(String(canonical.binding.conversationId))
            if (location === undefined) return false
            const platformMessageId =
              canonical.message.platformMessageId ?? canonical.binding.sourceMessageId
            return seenMessages.hasOrAdd(
              `${location.teamId}:${location.channelId}:${String(platformMessageId)}`,
            )
          },
          shouldInvoke: ({ input: canonical, policy, hasBinding, kind: invocationKind }) => {
            const location = decodeSlackConversationId(String(canonical.binding.conversationId))
            if (location === undefined) return false
            const isDirectMessage = isSlackDirectMessageChannel(location.channelId)
            // Mention-only channels invoke on a direct mention only:
            // the lifecycle promotes subscribed `isMention` messages to
            // `mention` kind, so `kind === 'mention'` preserves the
            // previous raw `isMention` check without raw parsing;
            // otherwise the verbatim input text must contain `<@bot>`.
            // `@channel`, `@here`, and user-group mentions never match
            // that shape. `all-messages` channels additionally invoke
            // on channel and native-thread messages without a mention
            // (user-created threads start a separate Friday thread),
            // matching Discord; `mention-only` thread replies still
            // need a mention or a bound thread.
            const isDirectMention =
              invocationKind === 'mention' ||
              containsDirectMention(canonical.message.content.text, slack.botUserId ?? '')
            return shouldInvokeSlack({
              isDirectMessage,
              hasBinding,
              isDirectMention,
              invocationMode: policy.invocationMode,
            })
          },
        },
        {
          hasBinding: (canonical) => ingestion.hasBinding(canonical),
          onAdmit: (admitted) => {
            const location = decodeSlackConversationId(String(admitted.binding.conversationId))
            const policy =
              location === undefined
                ? undefined
                : resolveChannelPolicy(location.teamId, location.channelId)
            return ingestion.ingest(
              admitted,
              bootstrap,
              (contextInput, cursor) =>
                policy !== undefined &&
                shouldLoadSlackContext({
                  created: cursor.created,
                  invocationMode: policy.invocationMode,
                  replyMode: policy.replyMode,
                })
                  ? loadSlackInitialContext(
                      slack,
                      config.current().agent.recentMessageCount,
                      contextInput,
                      cursor,
                    )
                  : Effect.succeed(contextInput),
              routeThread,
            )
          },
        },
      ),
  })
  yield* Effect.logInfo('slack.started').pipe(
    Effect.annotateLogs({
      component: 'slack',
      connectionId: String(slackConfig.connectionId),
      workspaceId,
      userAccessMode: slackConfig.access.users.mode,
      channelAccessMode: slackConfig.access.channels.mode,
      workspaceAccessMode: slackConfig.access.workspaces.mode,
      defaultReplyMode: slackConfig.defaultReplyMode,
      channelOverrideCount: slackConfig.channels.length,
    }),
  )
  return { connectionId: slackConfig.connectionId, platform: agentPlatform }
})
