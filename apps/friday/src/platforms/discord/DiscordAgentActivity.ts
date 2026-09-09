import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schedule from 'effect/Schedule'
import * as Semaphore from 'effect/Semaphore'
import type * as Duration from 'effect/Duration'

import type { PlatformAgentActivity } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

/** Discord presence derived from the global aggregate of active tasks. */
export interface DiscordPresence {
  /** Online when idle, idle while any task is active. */
  readonly status: 'online' | 'idle'
  /** Generic aggregate text; undefined shows no activity. Never task content. */
  readonly activity: string | undefined
  /** Count behind the derived state, kept for safe diagnostics. */
  readonly activeTaskCount: number
}

/** Single-attempt gateway update. The activity lifecycle owns retry policy. */
export interface DiscordPresenceGateway {
  readonly setPresence: (presence: DiscordPresence) => Effect.Effect<void, ChatSdkPublicationError>
}

/** One shared presence lifecycle: task updates and reconnect re-applies funnel
 * through the same versioned retry pipeline, so newer desired state always wins. */
export interface DiscordAgentActivityHandle {
  /** Maps a task transition to aggregate presence and dispatches it with retry. */
  readonly setAgentActivity: (
    input: PlatformAgentActivity,
  ) => Effect.Effect<void, ChatSdkPublicationError>
  /**
   * Re-applies the current aggregate through the same pipeline, forcing a write
   * even when the derived key matches the last applied one. Gateway (re)connects
   * lose server-side presence, so the stored desired state must converge again
   * with the same exponential backoff, attempt budget, and safe failure log.
   */
  readonly resyncPresence: () => Effect.Effect<void>
}

export interface DiscordAgentActivityOptions {
  /** Base delay for exponential presence retry. TestClock covers it in tests. */
  readonly retryBaseDelay?: Duration.Input | undefined
  /** Total update attempts including the initial one. Defaults to 5. */
  readonly maxAttempts?: number | undefined
}

/**
 * Maps the aggregate count to global presence. Zero tasks is online with no
 * activity; any tasks is idle with a generic count. Task names, channels,
 * guilds, and user content never reach this shape.
 */
export const deriveDiscordPresence = (activeTaskCount: number): DiscordPresence =>
  activeTaskCount <= 0
    ? { status: 'online', activity: undefined, activeTaskCount: 0 }
    : {
        status: 'idle',
        activity:
          activeTaskCount === 1 ? 'Working on 1 task' : `Working on ${activeTaskCount} tasks`,
        activeTaskCount,
      }

const presenceKey = (presence: DiscordPresence): string =>
  presence.activity === undefined ? presence.status : `${presence.status}\n${presence.activity}`

/**
 * Tracks every active task known by the platform activity lifecycle and keeps
 * one global Discord presence in sync with the aggregate count.
 *
 * Updates run on forked fibers so task completion never waits out backoff.
 * Each dispatch carries a version: a superseded loop ends quietly and never
 * marks its state applied, so newer states always win and a later change
 * attempts normally after exhaustion. Task transitions and reconnect resyncs
 * share this one pipeline: both dispatch through the same version counter,
 * mutex, fiber slot, exponential schedule, and safe exhaustion log.
 */
export const makeDiscordAgentActivity = Effect.fn('DiscordAgentActivity.make')(function* (
  gateway: DiscordPresenceGateway,
  options: DiscordAgentActivityOptions = {},
) {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5))
  const retrySchedule = Schedule.exponential(options.retryBaseDelay ?? '1 second').pipe(
    Schedule.upTo({ times: maxAttempts - 1 }),
  )
  const scope = yield* Effect.scope
  const applyMutex = yield* Semaphore.make(1)
  const activeTaskIds = new Set<string>()
  // Discord sessions start online with no activity; the gateway also
  // re-applies the stored desired state on every (re)connect.
  let appliedKey = presenceKey(deriveDiscordPresence(0))
  let version = 0
  let inflight:
    | {
        readonly key: string
        readonly version: number
        readonly fiber: Fiber.Fiber<void>
      }
    | undefined

  const applyWithRetry = (
    snapshot: DiscordPresence,
    key: string,
    attemptVersion: number,
  ): Effect.Effect<void> =>
    applyMutex
      .withPermit(
        Effect.gen(function* () {
          // The mutex serializes gateway writes while the version check runs
          // inside it, so the newest dispatched state always lands last.
          if (attemptVersion !== version) return yield* Effect.interrupt
          yield* gateway.setPresence(snapshot)
          if (attemptVersion === version) appliedKey = key
        }),
      )
      .pipe(
        Effect.retryOrElse(retrySchedule, (error) =>
          // Only the current generation reports exhaustion. Stale loops stay
          // silent and never cache their state, so exhaustion cannot poison
          // later changes. The final log carries only safe aggregate context
          // plus the typed error classification; the underlying defect is
          // never serialized.
          attemptVersion === version
            ? Effect.logError('discord.presence.update-failed').pipe(
                Effect.annotateLogs({
                  status: snapshot.status,
                  activeTaskCount: snapshot.activeTaskCount,
                  attempts: maxAttempts,
                  errorTag: error._tag,
                  operation: error.operation,
                }),
              )
            : Effect.void,
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (inflight?.version === attemptVersion) inflight = undefined
          }),
        ),
      )

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      version += 1
      const pending = inflight
      inflight = undefined
      activeTaskIds.clear()
      if (pending !== undefined) yield* Fiber.interrupt(pending.fiber)
      const online = deriveDiscordPresence(0)
      if (presenceKey(online) !== appliedKey) {
        yield* gateway.setPresence(online).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.logWarning('discord.presence.cleanup-failed').pipe(
                Effect.annotateLogs({
                  status: online.status,
                  errorTag: error._tag,
                  operation: error.operation,
                }),
              ),
            onSuccess: () => Effect.void,
          }),
        )
      }
    }),
  )

  const dispatch = (snapshot: DiscordPresence, key: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      version += 1
      const current = version
      const previous = inflight
      const fiber = yield* Effect.forkIn(applyWithRetry(snapshot, key, current), scope)
      inflight = { key, version: current, fiber }
      if (previous !== undefined) yield* Fiber.interrupt(previous.fiber)
    })

  const setAgentActivity = (
    input: PlatformAgentActivity,
  ): Effect.Effect<void, ChatSdkPublicationError> =>
    Effect.suspend(() => {
      if (input.active) activeTaskIds.add(input.taskId)
      else activeTaskIds.delete(input.taskId)
      const snapshot = deriveDiscordPresence(activeTaskIds.size)
      const key = presenceKey(snapshot)
      if (key === appliedKey && (inflight === undefined || inflight.key === appliedKey)) {
        return Effect.void
      }
      if (inflight !== undefined && inflight.key === key) return Effect.void
      return dispatch(snapshot, key)
    })

  const resyncPresence = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      const snapshot = deriveDiscordPresence(activeTaskIds.size)
      const key = presenceKey(snapshot)
      // Reconnects lose server-side presence, so force a write even when the
      // key matches the last applied one. An identical in-flight loop is
      // already converging, so only it is skipped; every other dispatch goes
      // through the shared versioned pipeline so newer states still win.
      if (inflight !== undefined && inflight.key === key) return Effect.void
      return dispatch(snapshot, key)
    })

  return { setAgentActivity, resyncPresence }
})

export const findDuplicateDiscordApplications = (
  connections: ReadonlyArray<{
    readonly connectionId: string
    readonly applicationId: string
    readonly botToken: string
  }>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const duplicates = new Map<string, Set<string>>()
  const collect = (key: string, connectionId: string) => {
    const existing = duplicates.get(key) ?? new Set<string>()
    existing.add(connectionId)
    duplicates.set(key, existing)
  }
  for (const connection of connections) {
    collect(`application:${connection.applicationId}`, connection.connectionId)
    collect(`token:${connection.botToken}`, connection.connectionId)
  }
  const groups = [...duplicates.values()]
    .filter((connectionIds) => connectionIds.size > 1)
    .map((connectionIds) => [...connectionIds].toSorted())
  const unique = new Map(
    groups.map((connectionIds) => [connectionIds.join('\u0000'), connectionIds]),
  )
  return [...unique.values()].toSorted((left, right) => left.join().localeCompare(right.join()))
}
