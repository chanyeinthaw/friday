/* oxlint-disable effecttsgo/any-unknown-in-error-context -- The SDK requires preserving the exact rollback error identity at this storage boundary. */
import {
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from '@earendil-works/pi-durable/storage/sqlite'
import * as Context from 'effect/Context'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Semaphore from 'effect/Semaphore'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { piOperation } from './Runtime.ts'

/** Uses a scoped SQLite connection dedicated to Pi; the layer closes it after the harness closes. */
export const makePiSqliteStorage = Effect.fn('PiSqliteStorage.open')(function* () {
  const sql = yield* SqlClient.SqlClient
  const context = yield* Effect.context<SqlClient.SqlClient>()
  const lock = yield* Semaphore.make(1)
  // Pi distinguishes guaranteed rollbacks by the original error identity.
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromiseExit(effect).then((exit) =>
      Exit.isSuccess(exit) ? exit.value : Promise.reject(Cause.squash(exit.cause)),
    )

  const executor = (executionContext: Context.Context<SqlClient.SqlClient>): SqliteExecutor => ({
    exec: (query) => run(sql.unsafe(query).pipe(Effect.asVoid, Effect.provide(executionContext))),
    run: (query, ...bindings) =>
      run(sql.unsafe(query, bindings).pipe(Effect.asVoid, Effect.provide(executionContext))),
    get: <T extends object>(query: string, ...bindings: SqliteValue[]) =>
      run(
        sql.unsafe<T>(query, bindings).pipe(
          Effect.map((rows) => rows[0]),
          Effect.provide(executionContext),
        ),
      ),
    all: <T extends object>(query: string, ...bindings: SqliteValue[]) =>
      run(
        sql.unsafe<T>(query, bindings).pipe(
          Effect.map((rows) => [...rows]),
          Effect.provide(executionContext),
        ),
      ),
  })
  const outside = executor(context)
  const database: SqliteDatabase = {
    exec: (query) =>
      run(
        lock.withPermit(
          Effect.tryPromise({ try: () => outside.exec(query), catch: (cause) => cause }),
        ),
      ),
    run: (query, ...bindings) =>
      run(
        lock.withPermit(
          Effect.tryPromise({
            try: () => outside.run(query, ...bindings),
            catch: (cause) => cause,
          }),
        ),
      ),
    get: (query, ...bindings) =>
      run(
        lock.withPermit(
          Effect.tryPromise({
            try: () => outside.get(query, ...bindings),
            catch: (cause) => cause,
          }),
        ),
      ),
    all: (query, ...bindings) =>
      run(
        lock.withPermit(
          Effect.tryPromise({
            try: () => outside.all(query, ...bindings),
            catch: (cause) => cause,
          }),
        ),
      ),
    transaction: (change) =>
      run(
        lock
          .withPermit(
            sql.withTransaction(
              Effect.gen(function* () {
                const transactionContext = yield* Effect.context<SqlClient.SqlClient>()
                return yield* Effect.tryPromise({
                  try: () => change(executor(transactionContext)),
                  catch: (cause) => cause,
                })
              }),
            ),
          )
          .pipe(Effect.provide(context)),
      ),
    close: () => Promise.resolve(),
  }
  return yield* piOperation('storage-open', () => SqliteStorage.open(database))
})
