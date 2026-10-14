import { Effect, Layer, Redacted, Schedule, Stream } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { HttpServerRequest } from 'effect/http'
import { Api, Authentication, CurrentUser, Unauthorized } from '../shared/Api.ts'
import { Auth } from './Auth.ts'
import { Chat } from './Chat.ts'
import { Storage } from './Storage.ts'
import { browseMemory, readMemoryOriginal } from './Memory.ts'
import { failure } from './errors.ts'

export const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const auth = yield* Auth
    return Authentication.of({
      bearer: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (request.headers.origin && request.headers.origin !== auth.origin)
            return yield* new Unauthorized({
              message: 'This request came from another application.',
            })
          const session = yield* auth
            .verify(Redacted.value(credential))
            .pipe(
              Effect.mapError(() => new Unauthorized({ message: 'Sign in again to continue.' })),
            )
          return yield* httpEffect.pipe(Effect.provideService(CurrentUser, session))
        }),
    })
  }),
)
export const chatApiLayer = HttpApiBuilder.group(
  Api,
  'chat',
  Effect.fn('HttpApi.chat')(function* (handlers) {
    const chat = yield* Chat
    const leases = new Map<string, { userId: string; expiresAt: number }>()
    const handle = Effect.fn('HttpApi.handle')(function* (
      command: Parameters<typeof chat.handle>[1],
    ) {
      const user = yield* CurrentUser
      return yield* chat.handle(user.userId, command)
    })
    return handlers
      .handle('startChatGpt', () => handle({ _tag: 'StartChatGpt' }))
      .handle('pollChatGpt', ({ payload }) => handle({ _tag: 'PollChatGpt', ...payload }))
      .handle('cancelChatGpt', ({ payload }) => handle({ _tag: 'CancelChatGpt', ...payload }))
      .handle('disconnectChatGpt', () => handle({ _tag: 'DisconnectChatGpt' }))
      .handle('history', ({ query }) => handle({ _tag: 'LoadOlder', beforeId: query.beforeId }))
      .handle('conversation', () => handle({ _tag: 'Load' }))
      .handle('send', ({ payload }) => handle({ _tag: 'Send', ...payload }))
      .handle('steer', ({ payload }) => handle({ _tag: 'Steer', ...payload }))
      .handle('stop', ({ payload }) => handle({ _tag: 'Stop', ...payload }))
      .handle('saveSettings', ({ payload }) => handle({ _tag: 'SaveSettings', ...payload }))
      .handle('discoverModels', ({ payload }) => handle({ _tag: 'DiscoverModels', ...payload }))
      .handle('renewEvents', ({ payload }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          const lease = leases.get(payload.streamId)
          if (!lease || lease.userId !== user.userId)
            return yield* failure('This conversation connection has ended.')
          lease.expiresAt = user.expiresAt + 15_000
          return {}
        }),
      )
      .handle('events', ({ query }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          return Stream.unwrap(
            Effect.gen(function* () {
              const streamId = crypto.randomUUID()
              const lease = { userId: user.userId, expiresAt: user.expiresAt + 15_000 }
              leases.set(streamId, lease)
              yield* Effect.addFinalizer(() => Effect.sync(() => leases.delete(streamId)))
              const updates = yield* chat.subscribe(user.userId, query.afterId)
              const expiry = Effect.suspend(() =>
                Effect.sleep(Math.max(0, lease.expiresAt - Date.now())),
              ).pipe(Effect.repeat({ until: () => Effect.succeed(Date.now() >= lease.expiresAt) }))
              const heartbeat = Stream.fromSchedule(Schedule.spaced('10 seconds')).pipe(
                Stream.map(() => ({ _tag: 'Heartbeat' as const })),
              )
              return Stream.make({ _tag: 'Ready' as const, userId: user.userId, streamId }).pipe(
                Stream.concat(Stream.merge(updates, heartbeat)),
                Stream.interruptWhen(expiry),
              )
            }),
          ).pipe(Stream.orDie)
        }),
      )
  }),
)
export const publicApiLayer = HttpApiBuilder.group(
  Api,
  'public',
  Effect.fn('HttpApi.public')(function* (handlers) {
    const auth = yield* Auth
    return handlers.handle('config', () => Effect.succeed({ publishableKey: auth.publishableKey }))
  }),
)
export const memoryApiLayer = HttpApiBuilder.group(
  Api,
  'memory',
  Effect.fn('HttpApi.memory')(function* (handlers) {
    const storage = yield* Storage
    return handlers
      .handle('browse', ({ query }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          return yield* browseMemory(user.userId, query).pipe(
            Effect.provideService(Storage, storage),
          )
        }),
      )
      .handle('original', ({ query }) =>
        Effect.gen(function* () {
          const user = yield* CurrentUser
          return yield* readMemoryOriginal(user.userId, query.id).pipe(
            Effect.provideService(Storage, storage),
          )
        }),
      )
  }),
)
export const apiLayer = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(chatApiLayer),
  Layer.provide(memoryApiLayer),
  Layer.provide(publicApiLayer),
  Layer.provide(authenticationLayer),
)
