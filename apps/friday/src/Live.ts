import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { FridayLive as FridayServiceLive } from './Friday.ts'
import { makeThreadCoordinator } from './conversation/ThreadCoordinator.ts'
import { ThreadRuntimePoolLive } from './conversation/ThreadRuntimePool.ts'
import { ThreadRuntimeError, ThreadRuntimes } from './conversation/ThreadRuntimes.ts'
import { AppConfig, AppConfigLive } from './config/AppConfigLive.ts'
import { PiModelRuntime, PiModelRuntimeLive } from './harness/pi/Live.ts'
import { makePiThreadRuntime } from './harness/pi/PiThreadRuntime.ts'
import { ThreadPersistenceLive } from './persistence/Live.ts'
import { PlatformIngestionLive } from './platforms/PlatformIngestion.ts'
import { PlatformRegistryLive } from './platforms/PlatformRegistry.ts'
import {
  SystemPromptTemplates,
  SystemPromptTemplatesLive,
} from './system-prompt/SystemPromptTemplates.ts'

const ThreadRuntimesLive = Layer.effect(
  ThreadRuntimes,
  Effect.gen(function* () {
    const modelRuntime = yield* PiModelRuntime
    const crypto = yield* Crypto.Crypto
    const configuration = yield* AppConfig
    const systemPromptTemplates = yield* SystemPromptTemplates

    return ThreadRuntimes.of({
      open: (thread) =>
        makePiThreadRuntime({
          thread,
          modelRuntime,
          systemPromptTemplates,
          availableAgentModels: configuration.models.subagents,
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (cause) =>
              new ThreadRuntimeError({
                operation: 'open',
                cause,
              }),
          ),
          Effect.map((runtime) => ({
            threadId: runtime.threadId,
            harnessSession: runtime.harnessSession,
            prompt: (request) =>
              runtime
                .prompt(request)
                .pipe(
                  Effect.mapError(
                    (cause) => new ThreadRuntimeError({ operation: 'prompt', cause }),
                  ),
                ),
            // Pi currently exposes no event-stream error, but the service
            // boundary permits other harnesses to expose one later.
            events: runtime.events,
          })),
        ),
    })
  }),
)

const CoreLive = Layer.mergeAll(
  ThreadPersistenceLive,
  PiModelRuntimeLive,
  BunCrypto.layer,
  BunFileSystem.layer,
  PlatformRegistryLive,
  AppConfigLive,
  SystemPromptTemplatesLive,
)

const RuntimeLive = ThreadRuntimesLive.pipe(Layer.provide(CoreLive))
const PoolLive = ThreadRuntimePoolLive((thread) =>
  Effect.gen(function* () {
    const runtime = yield* ThreadRuntimes.use((runtimes) => runtimes.open(thread))
    const coordinator = yield* makeThreadCoordinator(runtime)
    yield* coordinator.start
    return coordinator
  }),
).pipe(Layer.provide(Layer.merge(CoreLive, RuntimeLive)))
const AgentLive = FridayServiceLive.pipe(Layer.provide(PoolLive))
const IngestionLive = PlatformIngestionLive.pipe(
  Layer.provide(Layer.mergeAll(CoreLive, PoolLive, AgentLive)),
)

export const FridayLive = Layer.mergeAll(CoreLive, RuntimeLive, PoolLive, AgentLive, IngestionLive)
