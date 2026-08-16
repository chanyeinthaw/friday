import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'

import { ChatSdkLifecycleError } from '../chat-sdk/Errors.ts'

const GATEWAY_RESIDENT_DURATION_MS = 2_147_000_000

export const startDiscordGateway = Effect.fn('startDiscordGateway')(function* (
  discord: DiscordAdapter,
): Effect.fn.Return<void, never, Scope.Scope> {
  const abortController = new AbortController()
  const effectContext = yield* Effect.context()
  const runPromise = Effect.runPromiseWith(effectContext)

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const gateway = Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            void discord
              .startGatewayListener(
                {
                  waitUntil: (promise) => {
                    void promise.then(() => resolve(), reject)
                  },
                },
                GATEWAY_RESIDENT_DURATION_MS,
                abortController.signal,
              )
              .then((response) => {
                if (!response.ok) {
                  reject(new Error(`Discord Gateway failed to start: HTTP ${response.status}`))
                }
              }, reject)
          }),
        catch: (cause) =>
          new ChatSdkLifecycleError({
            operation: 'gateway',
            cause,
          }),
      })
      runPromise(gateway).catch((cause) => {
        console.error(cause)
      })
    }),
    () =>
      Effect.sync(() => {
        abortController.abort()
      }),
  )
})
