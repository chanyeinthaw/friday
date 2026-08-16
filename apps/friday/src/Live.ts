import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { makeFridayApplication } from './FridayApplication.ts'
import { PiModelRuntime, PiModelRuntimeLive } from './harness/pi/Live.ts'
import { makePiThreadRuntime } from './harness/pi/PiThreadRuntime.ts'
import { ThreadPersistenceLive } from './persistence/Live.ts'

export const FridayLive = Layer.mergeAll(
  ThreadPersistenceLive,
  PiModelRuntimeLive,
  BunCrypto.layer,
  BunFileSystem.layer,
)

export const makeFridayApplicationLive = Effect.fn('makeFridayApplicationLive')(function* () {
  const modelRuntime = yield* PiModelRuntime
  const crypto = yield* Crypto.Crypto
  return yield* makeFridayApplication((thread) =>
    makePiThreadRuntime({ thread, modelRuntime }).pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    ),
  )
})
