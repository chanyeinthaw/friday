/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- Pi's official storage conformance cases verify the Effect SQLite adapter in temporary databases. */
import { describe, expect, test } from 'bun:test'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import * as Effect from 'effect/Effect'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makePiSqliteStorage } from './SqliteStorage.ts'

registerStorageConformance({ describe, expect, it: test }, 'Effect SQLite storage', (use) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-pi-storage-'))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        )
        yield* Effect.gen(function* () {
          const storage = yield* Effect.acquireRelease(makePiSqliteStorage(), (storage) =>
            Effect.promise(() => storage.close(BACKGROUND_CONTEXT)),
          )
          yield* Effect.tryPromise(() => use(storage))
        }).pipe(Effect.provide(SqliteClient.layer({ filename: join(directory, 'pi.sqlite') })))
      }),
    ),
  ),
)
