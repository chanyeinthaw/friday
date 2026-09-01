import type { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schedule from 'effect/Schedule'
import * as Semaphore from 'effect/Semaphore'

import type { PlatformAdapter, PlatformAgentActivity } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

const activityPrefix = '⚡ '
const activityPrefixPattern = /^⚡ /u
const titleLimit = 100

interface ThreadActivityState {
  /** Active channel-agent turns; each begin/finalize (or discard) pair contributes one. */
  turns: number
  /** Active subagent and background task IDs reported via agent-activity events. */
  readonly tasks: Set<string>
  /** Last known thread name without the activity prefix. */
  baseName: string | null
  /** Last name successfully applied by this wrapper. */
  appliedName: string | null
}

interface DiscordThreadLocation {
  readonly guildId?: string | undefined
  readonly channelId?: string | undefined
  readonly threadId?: string | undefined
}

interface ConversationEntry {
  readonly lock: Semaphore.Semaphore
  readonly state: ThreadActivityState
  users: number
  evictWhenUnused: boolean
}

/** Narrow slice of the Discord adapter used for thread title reads and writes. */
export interface DiscordThreadTitleAdapter {
  decodeThreadId(threadId: string): DiscordThreadLocation
  encodeThreadId(location: DiscordThreadLocation): string
  fetchThread(threadId: string): Promise<{ readonly channelName?: string | undefined }>
  setThreadTitle(threadId: string, title: string): Promise<void>
}

const truncateTitle = (title: string): string => Array.from(title).slice(0, titleLimit).join('')

// Fresh schedule per use: schedules are stateful. Caps cleanup restores at 3 attempts
// (1 initial + 2 retries) with bounded exponential backoff; no background reaper.
const cleanupSchedule = () => Schedule.exponential('50 millis', 2).pipe(Schedule.upTo({ times: 2 }))

const bestEffort = <A>(
  conversationId: string,
  effect: Effect.Effect<A, ChatSdkPublicationError>,
  fallback: () => A,
): Effect.Effect<A> =>
  effect.pipe(
    Effect.tapError((cause) =>
      Effect.logWarning('discord.thread-activity-title.failed').pipe(
        Effect.annotateLogs({ conversationId, cause: String(cause) }),
      ),
    ),
    Effect.orElseSucceed(fallback),
  )

/**
 * Prefixes a Discord thread title with `⚡ ` while its channel turn or background tasks are active.
 * Discord reads and writes are best-effort and serialized per conversation; the idle restore is
 * retried with bounded backoff (max 3 attempts) and kept in state when it fails so the next
 * activity cycle retries it.
 */
export const withDiscordThreadActivityTitle = (
  discord: DiscordThreadTitleAdapter,
  platform: PlatformAdapter<ChatSdkPublicationError>,
): PlatformAdapter<ChatSdkPublicationError> => {
  const entries = new Map<string, ConversationEntry>()

  const entryFor = (conversationId: string): ConversationEntry => {
    const existing = entries.get(conversationId)
    if (existing) return existing
    const created: ConversationEntry = {
      lock: Semaphore.makeUnsafe(1),
      state: {
        turns: 0,
        tasks: new Set(),
        baseName: null,
        appliedName: null,
      },
      users: 0,
      evictWhenUnused: false,
    }
    entries.set(conversationId, created)
    return created
  }

  const serialized = (
    conversationId: string,
    operation: (entry: ConversationEntry) => Effect.Effect<boolean>,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      const entry = entryFor(conversationId)
      entry.users += 1
      return entry.lock
        .withPermit(
          // The adapter promises do not accept AbortSignal. Defer interruption after lock
          // acquisition so an in-flight request settles before the next operation can start.
          Effect.uninterruptible(
            operation(entry).pipe(
              Effect.tap((evictWhenUnused) =>
                Effect.sync(() => {
                  entry.evictWhenUnused = evictWhenUnused
                }),
              ),
            ),
          ),
        )
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.users -= 1
              if (
                entry.users === 0 &&
                entry.evictWhenUnused &&
                entries.get(conversationId) === entry
              ) {
                entries.delete(conversationId)
              }
            }),
          ),
          Effect.asVoid,
        )
    })

  const locationFor = (conversationId: string): DiscordThreadLocation | null => {
    const location = discord.decodeThreadId(conversationId)
    return location.threadId ? location : null
  }

  const fetchThreadName = (
    conversationId: string,
    location: DiscordThreadLocation,
  ): Effect.Effect<string | null, ChatSdkPublicationError> =>
    Effect.tryPromise({
      try: () =>
        discord
          .fetchThread(
            discord.encodeThreadId({
              guildId: location.guildId,
              channelId: location.threadId,
            }),
          )
          .then((thread) => thread.channelName ?? null),
      catch: (cause) =>
        new ChatSdkPublicationError({ operation: 'set-thread-activity-title', cause }),
    })

  const renameThread = (
    conversationId: string,
    name: string,
  ): Effect.Effect<void, ChatSdkPublicationError> =>
    Effect.tryPromise({
      try: () => discord.setThreadTitle(conversationId, name),
      catch: (cause) =>
        new ChatSdkPublicationError({ operation: 'set-thread-activity-title', cause }),
    })

  const refreshBaseName = (
    conversationId: string,
    location: DiscordThreadLocation,
    state: ThreadActivityState,
  ): Effect.Effect<void, ChatSdkPublicationError> =>
    fetchThreadName(conversationId, location).pipe(
      Effect.flatMap((name) => {
        if (name === null) {
          return Effect.fail(
            new ChatSdkPublicationError({
              operation: 'set-thread-activity-title',
              cause: new Error(`Discord thread '${location.threadId}' has no name`),
            }),
          )
        }
        if (name !== state.appliedName) state.baseName = name.replace(activityPrefixPattern, '')
        return Effect.void
      }),
    )

  const applyActivityTitle = (
    conversationId: string,
    state: ThreadActivityState,
  ): Effect.Effect<void, ChatSdkPublicationError> =>
    Effect.gen(function* () {
      if (state.baseName === null) return
      const active = state.turns > 0 || state.tasks.size > 0
      const desired = truncateTitle(`${active ? activityPrefix : ''}${state.baseName}`)
      if (desired === state.appliedName) return
      yield* renameThread(conversationId, desired)
      state.appliedName = desired
      yield* Effect.logInfo('discord.thread-activity-title.updated').pipe(
        Effect.annotateLogs({ conversationId, name: desired, active: String(active) }),
      )
    })

  const updateActivity = (
    binding: ConversationBinding,
    update: (state: ThreadActivityState) => void,
  ): Effect.Effect<void> => {
    const conversationId = String(binding.conversationId)
    const location = locationFor(conversationId)
    if (location === null) return Effect.void
    let cleanupFailed = false
    return serialized(conversationId, (entry) =>
      bestEffort(
        conversationId,
        Effect.gen(function* () {
          const state = entry.state
          const wasActive = state.turns > 0 || state.tasks.size > 0
          update(state)
          const active = state.turns > 0 || state.tasks.size > 0
          if (active !== wasActive || state.baseName === null) {
            yield* refreshBaseName(conversationId, location, state)
          }
          if (active) {
            yield* applyActivityTitle(conversationId, state)
          } else {
            // The idle restore is the cleanup rename: retry it with bounded backoff,
            // and if every attempt fails keep the idle entry so a later activity
            // cycle on the thread retries the restore.
            yield* applyActivityTitle(conversationId, state).pipe(
              Effect.retry(cleanupSchedule()),
              Effect.tapError(() =>
                Effect.sync(() => {
                  cleanupFailed = true
                }),
              ),
            )
          }
          return !active
        }),
        // Lookup failures evict so a later cycle re-fetches, but a failed cleanup
        // restore must not evict the idle state as if the restore had succeeded.
        () => !cleanupFailed && entry.state.turns === 0 && entry.state.tasks.size === 0,
      ),
    )
  }

  const markTurn = (binding: ConversationBinding, delta: 1 | -1): Effect.Effect<void> =>
    updateActivity(binding, (state) => {
      state.turns = Math.max(0, state.turns + delta)
    })

  const trackTask = (activity: PlatformAgentActivity): Effect.Effect<void> =>
    updateActivity(activity.binding, (state) => {
      if (activity.active) state.tasks.add(activity.taskId)
      else state.tasks.delete(activity.taskId)
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
    setConversationTitle: (title) => {
      const conversationId = String(title.binding.conversationId)
      if (locationFor(conversationId) === null) return platform.setConversationTitle(title)
      return serialized(conversationId, (entry) =>
        bestEffort(
          conversationId,
          Effect.gen(function* () {
            const state = entry.state
            state.baseName = title.title.replace(activityPrefixPattern, '')
            state.appliedName = null
            yield* applyActivityTitle(conversationId, state)
            return state.turns === 0 && state.tasks.size === 0
          }),
          () => entry.state.turns === 0 && entry.state.tasks.size === 0,
        ),
      )
    },
    setAgentActivity: (activity) =>
      trackTask(activity).pipe(Effect.andThen(platform.setAgentActivity(activity))),
  }
}
