import { BunRuntime, BunHttpServer } from '@effect/platform-bun'
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { Config, Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { frontendLayer } from './server/Frontend.ts'
import { authLayer } from './server/Auth.ts'
import { chatGptLayer } from './server/ChatGpt.ts'
import { agentRuntimeLayer } from './server/AgentRuntimeLive.ts'
import { chatLayer } from './server/Chat.ts'
import { credentialsLayer } from './server/Providers.ts'
import { sqliteMigrations, sqliteStorage } from './server/SqliteStorage.ts'
import { apiLayer } from './server/HttpApi.ts'

const database = Layer.unwrap(
  Config.String('WEDNESDAY_DATABASE').pipe(
    Config.withDefault('wednesday.sqlite'),
    Effect.map((filename) => SqliteClient.layer({ filename })),
  ),
)
const migrations = sqliteMigrations.pipe(Layer.provide(database))
const persistence = sqliteStorage.pipe(Layer.provide(migrations), Layer.provide(database))
const chat = chatLayer.pipe(
  Layer.provide(agentRuntimeLayer),
  Layer.provide(chatGptLayer),
  Layer.provide(persistence),
  Layer.provide(credentialsLayer),
)
const services = Layer.mergeAll(chat, authLayer)
const app = Layer.merge(apiLayer.pipe(Layer.provide(services)), frontendLayer).pipe(
  Layer.provide(BunHttpServer.layerHttpServices),
)
const program = Effect.gen(function* () {
  const port = yield* Config.Int('WEDNESDAY_PORT').pipe(Config.withDefault(3002))
  const hostname = yield* Config.String('WEDNESDAY_HOST').pipe(Config.withDefault('127.0.0.1'))
  const http = HttpRouter.toWebHandler(app, { disableLogger: true })
  yield* Effect.addFinalizer(() => Effect.promise(() => http.dispose()))
  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 0,
    maxRequestBodySize: 16_000_000,
    routes: {
      '/config': false,
      '/api/*': false,
      '/health': () => new Response('ok'),
    },
    fetch: (request) => http.handler(request),
  })
  yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
  yield* Effect.log(`Friday listening on ${hostname}:${server.port}`)
  return yield* Effect.never
}).pipe(Effect.scoped)
BunRuntime.runMain(program)
