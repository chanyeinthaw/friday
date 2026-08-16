/* oxlint-disable effecttsgo/node-builtin-import -- Temporary pre-configuration path composition uses the Node path API beside FRIDAY_HOME. */

import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import { join } from 'node:path'

import { ThreadPersistence } from '../conversation/ThreadPersistence.ts'
import { FRIDAY_HOME } from '../FridayHome.ts'
import { makeSqliteThreadPersistence } from './SqliteThreadPersistence.ts'

export const FRIDAY_DATABASE_PATH = join(FRIDAY_HOME, 'friday.sqlite')

const FridayHomeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    yield* fileSystem.makeDirectory(FRIDAY_HOME, { recursive: true })
  }),
).pipe(Layer.provide(BunFileSystem.layer))

const SqliteLive = SqliteClient.layer({ filename: FRIDAY_DATABASE_PATH }).pipe(
  Layer.provide(FridayHomeLive),
)

export const ThreadPersistenceLive = Layer.effect(
  ThreadPersistence,
  makeSqliteThreadPersistence(),
).pipe(Layer.provide(SqliteLive))
