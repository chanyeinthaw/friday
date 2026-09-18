import type { ConversationBinding, PlatformConnectionId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'

import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import type {
  PlatformAdapter,
  PlatformConversationTitleCapability,
  PlatformDiscoveryCapability,
  PlatformMembersCapability,
  PlatformMessageGetCapability,
  PlatformMessagePostCapability,
  PlatformMessageSearchCapability,
  PlatformWorkingMessageCapability,
} from '../PlatformAdapter.ts'
import {
  makeWorkingMessageLifecycle,
  splitMessage,
} from '../working-message/WorkingMessageLifecycle.ts'
import type { SlackAdapter } from '@chat-adapter/slack'
import {
  decodeSlackConversationId,
  isSlackThread,
  toSlackAdapterChannelId,
  toSlackAdapterThreadId,
} from './SlackConversationScope.ts'
import { getSlackMessage, postSlackMessage, searchSlackMessages } from './SlackMessageSearch.ts'
import {
  discoverSlack,
  listSlackMembers,
  type SlackDiscoveryPolicy,
  type SlackDiscoveryWebClient,
} from './SlackDiscovery.ts'

/** Slack message limit with headroom; chunks stay readable and fence-aware. */
export const SlackMaxMessageLength = 3500

const publicationError = (operation: ChatSdkPublicationError['operation'], cause: unknown) =>
  new ChatSdkPublicationError({ operation, cause })

export interface SlackAgentAdapter extends Pick<
  SlackAdapter,
  | 'postMessage'
  | 'postChannelMessage'
  | 'editMessage'
  | 'deleteMessage'
  | 'addReaction'
  | 'setAssistantTitle'
  | 'fetchMessages'
  | 'fetchChannelMessages'
  | 'fetchMessage'
  | 'fetchChannelInfo'
  | 'listThreads'
> {
  readonly webClient: SlackDiscoveryWebClient
}

const chunksFor = (text: string): ReadonlyArray<string> => splitMessage(text, SlackMaxMessageLength)

const adapterThreadIdFrom = (binding: ConversationBinding): string => {
  const location = decodeSlackConversationId(String(binding.conversationId))
  if (location === undefined) return String(binding.conversationId)
  return toSlackAdapterThreadId(location)
}

interface SlackWorkingHandle {
  readonly threadId: string
  readonly messageId: string
}

const latestSlackMessageId = async (
  adapter: SlackAgentAdapter,
  binding: ConversationBinding,
): Promise<string | undefined> => {
  const location = decodeSlackConversationId(String(binding.conversationId))
  if (location === undefined) return undefined
  if (isSlackThread(location)) {
    const page = await adapter.fetchMessages(toSlackAdapterThreadId(location), { limit: 1 })
    return page.messages.at(-1)?.id
  }
  const page = await adapter.fetchChannelMessages(toSlackAdapterChannelId(location), { limit: 1 })
  return page.messages.at(-1)?.id
}

const postChunks = Effect.fn('SlackPlatform.postChunks')(function* (
  adapter: SlackAgentAdapter,
  operation: ChatSdkPublicationError['operation'],
  binding: ConversationBinding,
  text: string,
) {
  const threadId = adapterThreadIdFrom(binding)
  for (const chunk of chunksFor(text)) {
    yield* Effect.tryPromise({
      try: () => adapter.postMessage(threadId, chunk),
      catch: (cause) => publicationError(operation, cause),
    })
  }
})

/**
 * Builds a Slack PlatformAdapter over the official Chat SDK adapter with Agent
 * Sessions over Socket Mode. Publishing targets the bound thread when the
 * conversation is thread-scoped, otherwise the channel. Working messages use
 * post-and-edit with plain visible text only; Friday never sets Agent session
 * status or typing state. Explicit titles mirror Friday's generated title to
 * the Slack session. Persistence, steering, tasks, routing, access, history,
 * and channel-scoped workspaces are unchanged; only the transport and Agent UI
 * surface moved to the official adapter.
 */
export const makeSlackPlatform = Effect.fn('makeSlackPlatform')(
  (
    connectionId: PlatformConnectionId,
    adapter: SlackAgentAdapter,
    policy: SlackDiscoveryPolicy,
  ): Effect.Effect<
    PlatformAdapter<ChatSdkPublicationError> &
      PlatformWorkingMessageCapability<ChatSdkPublicationError> &
      PlatformConversationTitleCapability<ChatSdkPublicationError> &
      PlatformMessageSearchCapability<ChatSdkPublicationError> &
      PlatformMessageGetCapability<ChatSdkPublicationError> &
      PlatformMessagePostCapability<ChatSdkPublicationError> &
      PlatformMembersCapability<ChatSdkPublicationError> &
      PlatformDiscoveryCapability<ChatSdkPublicationError>
  > =>
    Effect.sync(() => {
      const workingLifecycle = makeWorkingMessageLifecycle<
        SlackWorkingHandle,
        ChatSdkPublicationError
      >({
        chunksFor,
        post: async (binding, text) => {
          const threadId = adapterThreadIdFrom(binding)
          const posted = await adapter.postMessage(threadId, text)
          return { threadId, messageId: posted.id }
        },
        edit: async (handle, _binding, text) => {
          await adapter.editMessage(handle.threadId, handle.messageId, text)
          return handle
        },
        delete: (handle) => adapter.deleteMessage(handle.threadId, handle.messageId),
        latestId: (binding) => latestSlackMessageId(adapter, binding),
        idOf: (handle) => handle.messageId,
        mapError: (operation, cause) => publicationError(operation, cause),
      })

      return {
        connectionId,
        kind: 'slack',
        publish: (publication) =>
          postChunks(adapter, 'publish', publication.binding, publication.text),
        acknowledge: (target) =>
          Effect.tryPromise({
            try: () =>
              adapter.addReaction(
                adapterThreadIdFrom(target.binding),
                String(target.messageId),
                'eyes',
              ),
            catch: (cause) => publicationError('acknowledge', cause),
          }).pipe(Effect.asVoid),
        workingMessages: {
          begin: (message) => workingLifecycle.begin(message),
          update: (message) => workingLifecycle.update(message),
          finalize: (message) => workingLifecycle.finalize(message),
          discard: (binding) => workingLifecycle.discard(binding),
        },
        conversationTitle: {
          set: (title) =>
            Effect.gen(function* () {
              const location = decodeSlackConversationId(String(title.binding.conversationId))
              if (location === undefined || !isSlackThread(location)) return
              const trimmed = title.title.trim().slice(0, 80)
              if (trimmed === '') return
              yield* Effect.tryPromise({
                try: () =>
                  adapter.setAssistantTitle(location.channelId, location.threadTs ?? '', trimmed),
                catch: (cause) => publicationError('set-conversation-title', cause),
              }).pipe(
                Effect.tapError((cause) =>
                  Effect.logDebug('slack.session-title.failed', { cause: String(cause) }),
                ),
                Effect.ignore,
              )
            }),
        },
        messageSearch: { search: (query) => searchSlackMessages(adapter, query, policy) },
        messageGet: { get: (query) => getSlackMessage(adapter, query, policy) },
        messagePost: { post: (query) => postSlackMessage(adapter, query, policy) },
        members: { list: (query) => listSlackMembers(adapter, query, policy) },
        discovery: { discover: (query) => discoverSlack(adapter, query, policy) },
        withTyping: (_binding, effect) => effect,
      }
    }),
)
