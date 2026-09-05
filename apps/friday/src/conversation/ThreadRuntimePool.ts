import type { Thread, ThreadId } from '@friday/contracts/conversation'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import type { ThreadCoordinatorContract, TurnHandle } from './ThreadCoordinator.ts'
import type { ThreadPersistenceError } from './ThreadPersistence.ts'
import { harnessReloadRefused, type HarnessReloadOutcome } from './ThreadRuntime.ts'
import type { ThreadRuntimeError } from './ThreadRuntimes.ts'

export interface ThreadRuntimePoolOptions {
  readonly idleTimeout?: Duration.Input
  readonly reaperInterval?: Duration.Input
}

export interface ThreadRuntimePoolContract {
  readonly acquire: (
    thread: Thread,
  ) => Effect.Effect<
    ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>,
    ThreadRuntimeError | ThreadPersistenceError
  >
  /**
   * Reloads the harness session of an already-open runtime for the thread.
   * Never opens a runtime for a thread that has none, and refuses while a Turn
   * is active; the structured outcome reports either refusal.
   */
  readonly reloadHarness: (threadId: ThreadId) => Effect.Effect<HarnessReloadOutcome>
  readonly reapIdle: Effect.Effect<void>
}

export class ThreadRuntimePool extends Context.Service<
  ThreadRuntimePool,
  ThreadRuntimePoolContract
>()('friday/conversation/ThreadRuntimePool') {}

type ThreadCoordinator = ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>

interface ThreadRuntimeTracking {
  lastActivityAt: number
  activeTurns: number
}

interface ThreadRuntimeEntry {
  readonly coordinator: ThreadCoordinator
  readonly scope: Scope.Closeable
  readonly tracking: ThreadRuntimeTracking
}

const closeEntry = (entry: ThreadRuntimeEntry) => Scope.close(entry.scope, Exit.void)

const touch = (tracking: ThreadRuntimeTracking) =>
  Clock.currentTimeMillis.pipe(
    Effect.tap((now) =>
      Effect.sync(() => {
        tracking.lastActivityAt = now
      }),
    ),
    Effect.asVoid,
  )

const observeTerminal = (tracking: ThreadRuntimeTracking, handle: TurnHandle<ThreadRuntimeError>) =>
  Effect.gen(function* () {
    yield* Effect.exit(handle.awaitTerminal)
    const completedAt = yield* Clock.currentTimeMillis
    tracking.activeTurns -= 1
    tracking.lastActivityAt = completedAt
  })

const releasePromptAccounting = (tracking: ThreadRuntimeTracking) =>
  Effect.sync(() => {
    tracking.activeTurns -= 1
  })

const trackCoordinator = (
  coordinator: ThreadCoordinator,
  tracking: ThreadRuntimeTracking,
  scope: Scope.Closeable,
): ThreadCoordinator => ({
  ...coordinator,
  prompt: (turn) =>
    Effect.gen(function* () {
      yield* touch(tracking)
      tracking.activeTurns += 1
      const handle = yield* coordinator
        .prompt(turn)
        .pipe(Effect.tapError(() => releasePromptAccounting(tracking)))
      yield* observeTerminal(tracking, handle).pipe(Effect.forkIn(scope))
      return handle
    }),
  steer: (turnId, activity) =>
    touch(tracking).pipe(Effect.andThen(coordinator.steer(turnId, activity))),
})

const openRuntimeEntry = <R>(
  openThread: (
    thread: Thread,
  ) => Effect.Effect<
    ThreadCoordinator,
    ThreadRuntimeError | ThreadPersistenceError,
    Scope.Scope | R
  >,
  context: Context.Context<R>,
  thread: Thread,
  lastActivityAt: number,
): Effect.Effect<ThreadRuntimeEntry, ThreadRuntimeError | ThreadPersistenceError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make('sequential')
    const coordinator = yield* openThread(thread).pipe(
      Scope.provide(scope),
      Effect.provide(context),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    )
    const tracking: ThreadRuntimeTracking = {
      lastActivityAt,
      activeTurns: 0,
    }
    return {
      coordinator: trackCoordinator(coordinator, tracking, scope),
      scope,
      tracking,
    }
  })

const reuseRuntimeEntry = (thread: Thread, entry: ThreadRuntimeEntry, now: number) =>
  Effect.gen(function* () {
    entry.tracking.lastActivityAt = now
    yield* Effect.logDebug('thread.runtime.reused').pipe(
      Effect.annotateLogs({
        component: 'runtime-pool',
        threadId: thread.id,
        activeTurns: entry.tracking.activeTurns,
      }),
    )
    return entry.coordinator
  })

export const ThreadRuntimePoolLive = <R>(
  openThread: (
    thread: Thread,
  ) => Effect.Effect<
    ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>,
    ThreadRuntimeError | ThreadPersistenceError,
    Scope.Scope | R
  >,
  options: ThreadRuntimePoolOptions = {},
): Layer.Layer<ThreadRuntimePool, never, R> =>
  Layer.effect(
    ThreadRuntimePool,
    Effect.gen(function* () {
      const context = yield* Effect.context<R>()
      const parentScope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const entries = new Map<ThreadId, ThreadRuntimeEntry>()
      const idleTimeout = Duration.toMillis(options.idleTimeout ?? '30 minutes')
      const reaperInterval = options.reaperInterval ?? '1 minute'

      const reapIdle = lock.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const reaped: Array<ThreadRuntimeEntry> = []
          const reapedThreadIds: Array<ThreadId> = []
          for (const [threadId, entry] of entries) {
            if (entry.tracking.activeTurns > 0 || now - entry.tracking.lastActivityAt < idleTimeout)
              continue
            entries.delete(threadId)
            reaped.push(entry)
            reapedThreadIds.push(threadId)
          }
          yield* Effect.forEach(reaped, closeEntry, { discard: true })
          if (reaped.length > 0) {
            yield* Effect.logInfo('thread.runtime.reaped').pipe(
              Effect.annotateLogs({
                component: 'runtime-pool',
                count: reaped.length,
                threadIds: reapedThreadIds,
              }),
            )
          }
        }),
      )

      const acquireRuntime = (thread: Thread) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const existing = entries.get(thread.id)
          if (existing !== undefined) return yield* reuseRuntimeEntry(thread, existing, now)

          const entry = yield* openRuntimeEntry(openThread, context, thread, now)
          entries.set(thread.id, entry)
          yield* Effect.logInfo('thread.runtime.opened').pipe(
            Effect.annotateLogs({
              component: 'runtime-pool',
              threadId: thread.id,
              audience: thread.audience,
              harness: thread.harness,
            }),
          )
          return entry.coordinator
        })

      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(reaperInterval).pipe(Effect.andThen(reapIdle))),
      )
      yield* Scope.addFinalizer(
        parentScope,
        lock.withPermit(
          Effect.gen(function* () {
            const active = Array.from(entries.values())
            entries.clear()
            yield* Effect.forEach(active, closeEntry, { discard: true })
          }),
        ),
      )

      return ThreadRuntimePool.of({
        // The lock covers lookup and opening so concurrent acquisition of one thread opens once.
        acquire: (thread) => lock.withPermit(acquireRuntime(thread)),
        reapIdle,
        reloadHarness: (threadId) =>
          lock.withPermit(
            Effect.gen(function* () {
              const entry = entries.get(threadId)
              if (entry === undefined) {
                yield* Effect.logDebug('thread.runtime.reload-absent').pipe(
                  Effect.annotateLogs({
                    component: 'runtime-pool',
                    threadId,
                  }),
                )
                return harnessReloadRefused(
                  'no-runtime',
                  'No live harness runtime is open for this thread; send a message to start one before reloading.',
                )
              }
              if (entry.tracking.activeTurns > 0) {
                yield* Effect.logDebug('thread.runtime.reload-busy').pipe(
                  Effect.annotateLogs({
                    component: 'runtime-pool',
                    threadId,
                    activeTurns: entry.tracking.activeTurns,
                  }),
                )
                return harnessReloadRefused(
                  'busy',
                  'A turn is active in this thread; wait for it to finish before reloading.',
                )
              }
              return yield* entry.coordinator.reload()
            }),
          ),
      })
    }),
  )
