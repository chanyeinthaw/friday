// Run with the development volume mounted read-only; pipe stdout directly into cache-benchmark.ts.
import { Database } from 'bun:sqlite'
import { Effect, Schema } from 'effect'
import { StoredSettings } from '../src/server/Storage.ts'
import { failure } from '../src/server/errors.ts'

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSettings))
const program = Effect.acquireUseRelease(
  Effect.sync(
    () =>
      new Database(Bun.env.FRIDAY_BENCHMARK_DATABASE ?? '/source/wednesday.sqlite', {
        readonly: true,
      }),
  ),
  (database) =>
    Effect.gen(function* () {
      const rows = database
        .query<{ payload: string }, []>('SELECT payload FROM wednesday_settings')
        .all()
      const connections: string[] = []
      for (const row of rows) {
        const saved = yield* decode(row.payload)
        if (saved.settings.provider === 'chatgpt') connections.push(row.payload)
      }
      if (connections.length !== 1)
        return yield* failure('Expected one saved development ChatGPT connection.')
      yield* Effect.promise(() => Bun.stdout.write(connections[0] ?? ''))
    }),
  (database) => Effect.sync(() => database.close()),
)
await Effect.runPromise(
  program.pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        process.exitCode = 1
      }),
    ),
  ),
)
