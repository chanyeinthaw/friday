import type { Thread, ThreadId } from '@friday/contracts/conversation'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import type { ThreadCoordinatorContract } from './ThreadCoordinator.ts'
import type { ThreadPersistenceError } from './ThreadPersistence.ts'
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
  readonly reapIdle: Effect.Effect<void>
}

export class ThreadRuntimePool extends Context.Service<
  ThreadRuntimePool,
  ThreadRuntimePoolContract
>()('friday/conversation/ThreadRuntimePool') {}

const closeEntry = (entry: ThreadRuntimeEntry) => Scope.close(entry.scope, Exit.void)

interface ThreadRuntimeEntry {
  coordinator: ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError>
  readonly scope: Scope.Closeable
  lastActivityAt: number
  activeTurns: number
}

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
          for (const [threadId, entry] of entries) {
            if (entry.activeTurns > 0 || now - entry.lastActivityAt < idleTimeout) continue
            entries.delete(threadId)
            reaped.push(entry)
          }
          yield* Effect.forEach(reaped, closeEntry, { discard: true })
        }),
      )

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
        acquire: (thread) =>
          lock.withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const existing = entries.get(thread.id)
              if (existing) {
                existing.lastActivityAt = now
                return existing.coordinator
              }

              const scope = yield* Scope.make('sequential')
              const coordinator = yield* openThread(thread).pipe(
                Scope.provide(scope),
                Effect.provide(context),
                Effect.onError(() => Scope.close(scope, Exit.void)),
              )
              const entry: ThreadRuntimeEntry = {
                coordinator,
                scope,
                lastActivityAt: now,
                activeTurns: 0,
              }
              const tracked: ThreadCoordinatorContract<ThreadRuntimeError, ThreadRuntimeError> = {
                ...coordinator,
                prompt: (turn) =>
                  Effect.gen(function* () {
                    entry.lastActivityAt = yield* Clock.currentTimeMillis
                    entry.activeTurns += 1
                    const handle = yield* coordinator.prompt(turn).pipe(
                      Effect.tapError(() =>
                        Effect.sync(() => {
                          entry.activeTurns -= 1
                        }),
                      ),
                    )
                    yield* handle.awaitTerminal.pipe(
                      Effect.exit,
                      Effect.andThen(
                        Clock.currentTimeMillis.pipe(
                          Effect.flatMap((completedAt) =>
                            Effect.sync(() => {
                              entry.activeTurns -= 1
                              entry.lastActivityAt = completedAt
                            }),
                          ),
                        ),
                      ),
                      Effect.forkIn(entry.scope),
                    )
                    return handle
                  }),
                steer: (turnId, activity) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.tap((steeredAt) =>
                      Effect.sync(() => {
                        entry.lastActivityAt = steeredAt
                      }),
                    ),
                    Effect.andThen(coordinator.steer(turnId, activity)),
                  ),
              }
              entry.coordinator = tracked
              entries.set(thread.id, entry)
              return tracked
            }),
          ),
        reapIdle,
      })
    }),
  )
