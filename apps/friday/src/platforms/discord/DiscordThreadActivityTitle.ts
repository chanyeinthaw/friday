import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Semaphore from 'effect/Semaphore'

import type { PlatformAdapter, PlatformAgentActivity } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

const activityPrefix = '⚡ '
const activityPrefixPattern = /^⚡ /u
const titleLimit = 100
const discordApiBase = 'https://discord.com/api/v10'

interface ThreadActivityState {
  /** Active channel-agent turns; each begin/finalize (or discard) pair contributes one. */
  turns: number
  /** Active subagent and background task IDs reported via agent-activity events. */
  readonly tasks: Set<string>
  /** Last known thread name without the activity prefix; null until first observed. */
  baseName: string | null
  /** Name believed to be set on Discord right now, used to skip redundant renames. */
  appliedName: string | null
}

/** Narrow slice of the Discord adapter the wrapper needs to resolve thread IDs. */
export interface DiscordThreadLocator {
  decodeThreadId(threadId: string): { readonly threadId?: string | undefined }
}

/**
 * Wraps a chat-SDK platform so a Discord thread's title is prefixed with `⚡ ` while
 * the thread has active work: a running channel-agent turn or one or more running
 * subagent/background tasks. The prefix is a single marker (never a count) and is
 * removed once no work is active.
 *
 * The wrapper is additive and best-effort: title sync failures are logged and never
 * fail the wrapped platform operations. State lives in memory; the current thread
 * name is fetched from Discord when unknown, and any existing prefix is stripped
 * first so the original title is preserved and prefixes never duplicate.
 */
export const withDiscordThreadActivityTitle = (
  discord: DiscordThreadLocator,
  botToken: string,
  platform: PlatformAdapter<ChatSdkPublicationError>,
): PlatformAdapter<ChatSdkPublicationError> => {
  const lock = Semaphore.makeUnsafe(1)
  const states = new Map<string, ThreadActivityState>()

  const stateFor = (conversationId: string): ThreadActivityState => {
    const existing = states.get(conversationId)
    if (existing) return existing
    const created: ThreadActivityState = {
      turns: 0,
      tasks: new Set(),
      baseName: null,
      appliedName: null,
    }
    states.set(conversationId, created)
    return created
  }

  const threadIdFromConversation = (conversationId: string): string | null =>
    discord.decodeThreadId(conversationId).threadId ?? null
  const threadIdFromBinding = (binding: ConversationBinding): string | null =>
    threadIdFromConversation(String(binding.conversationId))

  const fetchThreadName = (
    threadId: string,
  ): Effect.Effect<string | null, ChatSdkPublicationError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${discordApiBase}/channels/${threadId}`, {
          headers: { Authorization: `Bot ${botToken}` },
        })
        if (!response.ok) throw new Error(`Discord thread lookup failed: HTTP ${response.status}`)
        // SAFETY: Discord's documented channel response exposes an optional name.
        const channel = (await response.json()) as { name?: string }
        return channel.name ?? null
      },
      catch: (cause) =>
        new ChatSdkPublicationError({ operation: 'set-thread-activity-title', cause }),
    })

  const renameThread = (
    threadId: string,
    name: string,
  ): Effect.Effect<void, ChatSdkPublicationError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${discordApiBase}/channels/${threadId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!response.ok) throw new Error(`Discord thread rename failed: HTTP ${response.status}`)
      },
      catch: (cause) =>
        new ChatSdkPublicationError({ operation: 'set-thread-activity-title', cause }),
    })

  // Caller must hold `lock`; state must already exist for the conversation.
  const applyActivityTitle = (
    conversationId: string,
    state: ThreadActivityState,
  ): Effect.Effect<void, ChatSdkPublicationError> =>
    Effect.gen(function* () {
      const threadId = threadIdFromConversation(conversationId)
      if (threadId === null) return
      if (state.baseName === null) {
        yield* fetchThreadName(threadId).pipe(
          Effect.flatMap((name) =>
            name === null
              ? Effect.fail(
                  new ChatSdkPublicationError({
                    operation: 'set-thread-activity-title',
                    cause: new Error(`Discord thread '${threadId}' has no name`),
                  }),
                )
              : Effect.sync(() => {
                  state.baseName = name.replace(activityPrefixPattern, '')
                }),
          ),
        )
      }
      const active = state.turns > 0 || state.tasks.size > 0
      const desired = `${active ? activityPrefix : ''}${state.baseName}`.slice(0, titleLimit)
      if (desired === state.appliedName) return
      yield* renameThread(threadId, desired)
      state.appliedName = desired
      yield* Effect.logInfo('discord.thread-activity-title.updated').pipe(
        Effect.annotateLogs({ conversationId, name: desired, active: String(active) }),
      )
    })

  const applyActivityTitleBestEffort = (conversationId: string): Effect.Effect<void> =>
    lock
      .withPermit(
        Effect.suspend(() => {
          const state = states.get(conversationId)
          return state ? applyActivityTitle(conversationId, state) : Effect.void
        }),
      )
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning('discord.thread-activity-title.failed').pipe(
            Effect.annotateLogs({ conversationId, cause: String(cause) }),
          ),
        ),
        Effect.ignore,
      )

  const markTurn = (binding: ConversationBinding, delta: 1 | -1): Effect.Effect<void> =>
    Effect.suspend(() => {
      const conversationId = String(binding.conversationId)
      if (threadIdFromBinding(binding) === null) return Effect.void
      const state = stateFor(conversationId)
      state.turns = Math.max(0, state.turns + delta)
      return applyActivityTitleBestEffort(conversationId)
    })

  const trackTask = (activity: PlatformAgentActivity): Effect.Effect<void> =>
    Effect.suspend(() => {
      const conversationId = String(activity.binding.conversationId)
      if (threadIdFromConversation(conversationId) === null) return Effect.void
      const state = stateFor(conversationId)
      if (activity.active) state.tasks.add(activity.taskId)
      else state.tasks.delete(activity.taskId)
      return Effect.void
    })

  return {
    connectionId: platform.connectionId,
    kind: platform.kind,
    publish: platform.publish,
    acknowledge: platform.acknowledge,
    updateWorking: platform.updateWorking,
    searchMessages: platform.searchMessages,
    withTyping: platform.withTyping,
    beginWorking: (message) =>
      markTurn(message.binding, 1).pipe(Effect.andThen(platform.beginWorking(message))),
    finalizeWorking: (message) =>
      markTurn(message.binding, -1).pipe(Effect.andThen(platform.finalizeWorking(message))),
    discardWorking: (binding) =>
      markTurn(binding, -1).pipe(Effect.andThen(platform.discardWorking(binding))),
    setConversationTitle: (title) =>
      lock.withPermit(
        Effect.gen(function* () {
          const conversationId = String(title.binding.conversationId)
          const threadId = threadIdFromConversation(conversationId)
          if (threadId === null) return yield* platform.setConversationTitle(title)
          const state = stateFor(conversationId)
          // A generated title replaces the base name; the prefix is reapplied on top if work is active.
          state.baseName = title.title.replace(activityPrefixPattern, '')
          yield* applyActivityTitle(conversationId, state)
        }),
      ),
    setAgentActivity: (activity) =>
      trackTask(activity).pipe(
        Effect.andThen(applyActivityTitleBestEffort(String(activity.binding.conversationId))),
        Effect.andThen(platform.setAgentActivity(activity)),
      ),
  }
}
