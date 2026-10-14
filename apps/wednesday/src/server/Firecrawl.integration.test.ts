import { test, expect } from 'bun:test'
import { ConfigProvider, Effect, Layer, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { Firecrawl, firecrawlLayer } from './Firecrawl.ts'
import { credentialsLayer } from './Providers.ts'
import { Storage } from './Storage.ts'
import { sqliteMigrations, sqliteStorage } from './SqliteStorage.ts'

const decodeSearch = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      limit: Schema.Number,
      sources: Schema.Array(Schema.String),
    }),
  ),
)

test('Firecrawl isolates encrypted keys, reports usage, searches, and revokes active tools on disconnect', async () => {
  const database = SqliteClient.layer({ filename: ':memory:' })
  const storage = sqliteStorage.pipe(
    Layer.provide(sqliteMigrations.pipe(Layer.provide(database))),
    Layer.provide(database),
  )
  let responseStatus = 200
  let requests = 0
  const mockFetch: typeof globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests++
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fc-private-test')
      const url = input instanceof Request ? input.url : input.toString()
      expect(url.startsWith('https://api.firecrawl.dev/v2/')).toBe(true)
      if (responseStatus !== 200)
        return Response.json(
          { error: 'fc-private-test must never leak' },
          { status: responseStatus },
        )
      if (url.endsWith('/search')) {
        expect(decodeSearch(await new Request(url, init).text())).toEqual({
          query: 'Effect documentation',
          limit: 5,
          sources: ['web'],
        })
        return Response.json({
          success: true,
          data: {
            web: [
              {
                title: 'Effect',
                url: 'https://effect.website',
                description: 'Official documentation',
              },
            ],
          },
        })
      }
      return Response.json({
        success: true,
        data: {
          remainingCredits: 1200,
          planCredits: 1000,
          billingPeriodStart: null,
          billingPeriodEnd: null,
        },
      })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  const services = Layer.merge(
    storage,
    firecrawlLayer.pipe(Layer.provide(storage), Layer.provide(credentialsLayer)),
  )
  // Bun SQLite requires the Bun integration runner.
  // oxlint-disable-next-line effect-local/no-manual-effect-runtime-in-tests
  await Effect.runPromise(
    Effect.gen(function* () {
      const firecrawl = yield* Firecrawl
      const stored = yield* Storage
      expect(yield* firecrawl.status('alice')).toEqual({ connected: false, usage: null })
      expect(yield* firecrawl.tool('alice')).toBeUndefined()
      const connected = yield* firecrawl.connect('alice', 'fc-private-test')
      expect(connected.usage?.remainingCredits).toBe(1200)
      expect(JSON.stringify(connected)).not.toContain('fc-private-test')
      const encrypted = yield* stored.integrationKey('alice', 'firecrawl')
      expect(encrypted).toBeTruthy()
      expect(encrypted).not.toContain('fc-private-test')
      expect(yield* stored.integrationKey('bob', 'firecrawl')).toBeNull()
      expect(yield* firecrawl.tool('bob')).toBeUndefined()
      const search = yield* firecrawl.tool('alice')
      if (!search) return yield* Effect.die('Expected search tool')
      expect(yield* search('Effect documentation')).toContain('https://effect.website')
      const calls = requests
      expect((yield* Effect.result(search(' '.repeat(501))))._tag).toBe('Failure')
      expect(requests).toBe(calls)
      responseStatus = 429
      const limited = yield* Effect.result(search('Effect documentation'))
      expect(limited._tag).toBe('Failure')
      if (limited._tag === 'Failure') {
        expect(limited.failure.message).toContain('limit reached')
        expect(limited.failure.message).not.toContain('fc-private-test')
      }
      const status = yield* firecrawl.status('alice')
      expect(status.connected).toBe(true)
      expect(status.usage).toBeNull()
      expect(status.usageError).toBeTruthy()
      responseStatus = 401
      expect((yield* Effect.result(firecrawl.connect('bob', 'fc-private-test')))._tag).toBe(
        'Failure',
      )
      expect(yield* stored.integrationKey('bob', 'firecrawl')).toBeNull()
      yield* firecrawl.disconnect('alice')
      expect((yield* Effect.result(search('Effect documentation')))._tag).toBe('Failure')
      expect(yield* stored.integrationKey('alice', 'firecrawl')).toBeNull()
      expect(yield* firecrawl.tool('alice')).toBeUndefined()
    }).pipe(
      Effect.provide(services),
      Effect.provideService(FetchHttpClient.Fetch, mockFetch),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({
          WEDNESDAY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
        }),
      ),
      Effect.scoped,
    ),
  )
})
