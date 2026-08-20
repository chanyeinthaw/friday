/* oxlint-disable effecttsgo/strict-effect-provide -- The test provides an isolated Bun FileSystem at its entry point. */

import { assert, it } from '@effect/vitest'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'

import { withFridayLogging } from './Live.ts'

const LogEntry = Schema.fromJsonString(
  Schema.Struct({
    level: Schema.String,
    message: Schema.Unknown,
    annotations: Schema.Record(Schema.String, Schema.Unknown),
  }),
)
const decodeLogEntry = Schema.decodeUnknownSync(LogEntry)

it.effect('writes structured JSONL and flushes it when the logging scope closes', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: 'friday-logging-' })
      const directory = `${root}/logs`
      const path = `${directory}/friday.jsonl`

      yield* Effect.scoped(
        withFridayLogging(
          Effect.logInfo('turn.completed').pipe(
            Effect.annotateLogs({
              component: 'ingestion',
              threadId: 'thread-test',
              turnId: 'turn-test',
            }),
          ),
          { directory, path },
        ),
      )

      const source = yield* fileSystem.readFileString(path)
      const entries = source
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => decodeLogEntry(line))
      const entry = entries.find(({ message }) => message === 'turn.completed')

      assert(entry !== undefined)
      assert.strictEqual(entry.level, 'INFO')
      assert.strictEqual(entry.annotations.component, 'ingestion')
      assert.strictEqual(entry.annotations.threadId, 'thread-test')
      assert.strictEqual(entry.annotations.turnId, 'turn-test')
    }),
  ).pipe(Effect.provide(BunFileSystem.layer)),
)
