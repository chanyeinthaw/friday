import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as Crypto from 'effect/Crypto'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { FridayLive as FridayServiceLive } from './Friday.ts'
import { ChannelProgress, ChannelProgressLive } from './conversation/ChannelProgress.ts'
import { ChannelTurnsLive } from './conversation/ChannelTurns.ts'
import { makeThreadCoordinator } from './conversation/ThreadCoordinator.ts'
import { ThreadRuntimePoolLive } from './conversation/ThreadRuntimePool.ts'
import { ThreadRuntimeError, ThreadRuntimes } from './conversation/ThreadRuntimes.ts'
import { AppConfig, AppConfigLive } from './config/AppConfigLive.ts'
import { PiModelRuntime, PiModelRuntimeLive } from './harness/pi/Live.ts'
import { makePiTextGeneration } from './harness/pi/PiTextGeneration.ts'
import { TextGeneration } from './harness/TextGeneration.ts'
import { makePiThreadRuntime } from './harness/pi/PiThreadRuntime.ts'
import { ThreadPersistenceLive } from './persistence/Live.ts'
import { ConversationTitlesLive } from './platforms/ConversationTitles.ts'
import { PlatformIngestionLive } from './platforms/PlatformIngestion.ts'
import { PlatformRegistry, PlatformRegistryLive } from './platforms/PlatformRegistry.ts'
import {
  SystemPromptTemplates,
  SystemPromptTemplatesLive,
} from './system-prompt/SystemPromptTemplates.ts'
import { TaskModelsLive } from './tasks/TaskModels.ts'
import { TaskToolDispatcher, TaskToolDispatcherLive } from './tasks/TaskToolDispatcher.ts'
import { Tasks, TasksLive } from './tasks/Tasks.ts'

const ThreadRuntimesLive = Layer.effect(
  ThreadRuntimes,
  Effect.gen(function* () {
    const modelRuntime = yield* PiModelRuntime
    const crypto = yield* Crypto.Crypto
    const configuration = yield* AppConfig
    const systemPromptTemplates = yield* SystemPromptTemplates
    const tasks = yield* TaskToolDispatcher
    const platforms = yield* PlatformRegistry

    return ThreadRuntimes.of({
      open: (thread) =>
        makePiThreadRuntime({
          thread,
          modelRuntime,
          systemPromptTemplates,
          availableAgentModels: configuration.models.subagents,
          tasks,
          platforms,
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
            cancel: (turnId) =>
              runtime
                .cancel(turnId)
                .pipe(
                  Effect.mapError(
                    (cause) => new ThreadRuntimeError({ operation: 'prompt', cause }),
                  ),
                ),
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
  TaskToolDispatcherLive,
)

const TextGenerationLive = Layer.effect(TextGeneration, makePiTextGeneration()).pipe(
  Layer.provide(CoreLive),
)
const ConversationTitlesConfiguredLive = ConversationTitlesLive.pipe(Layer.provide(CoreLive))
const ChannelProgressConfiguredLive = ChannelProgressLive.pipe(Layer.provide(CoreLive))
const RuntimeLive = ThreadRuntimesLive.pipe(Layer.provide(CoreLive))
const PoolLive = ThreadRuntimePoolLive((thread) =>
  Effect.gen(function* () {
    const runtime = yield* ThreadRuntimes.use((runtimes) => runtimes.open(thread))
    const coordinator = yield* makeThreadCoordinator(runtime)
    const progress = yield* ChannelProgress
    yield* coordinator.start
    if (thread.audience === 'user') {
      yield* coordinator.onEvent((event) => progress.observe(thread.id, event).pipe(Effect.ignore))
    }
    return coordinator
  }),
).pipe(Layer.provide(Layer.mergeAll(CoreLive, RuntimeLive, ChannelProgressConfiguredLive)))
const AgentLive = FridayServiceLive.pipe(Layer.provide(PoolLive))
const ChannelTurnsConfiguredLive = ChannelTurnsLive.pipe(
  Layer.provide(Layer.mergeAll(CoreLive, AgentLive, ChannelProgressConfiguredLive)),
)
const TaskModelsConfiguredLive = Layer.unwrap(
  Effect.gen(function* () {
    const configuration = yield* AppConfig
    return TaskModelsLive(configuration.models.subagents)
  }),
).pipe(Layer.provide(CoreLive))
const TasksConfiguredLive = TasksLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CoreLive,
      AgentLive,
      ChannelProgressConfiguredLive,
      ConversationTitlesConfiguredLive,
      ChannelTurnsConfiguredLive,
      TaskModelsConfiguredLive,
    ),
  ),
)
const TaskToolBindingLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const dispatcher = yield* TaskToolDispatcher
    const tasks = yield* Tasks
    yield* dispatcher.bind(tasks)
  }),
).pipe(Layer.provide(Layer.merge(CoreLive, TasksConfiguredLive)))
const IngestionLive = PlatformIngestionLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      CoreLive,
      ChannelTurnsConfiguredLive,
      ConversationTitlesConfiguredLive,
      TextGenerationLive,
    ),
  ),
)

export const FridayLive = Layer.mergeAll(
  CoreLive,
  RuntimeLive,
  PoolLive,
  AgentLive,
  TextGenerationLive,
  ConversationTitlesConfiguredLive,
  ChannelProgressConfiguredLive,
  ChannelTurnsConfiguredLive,
  TaskModelsConfiguredLive,
  TasksConfiguredLive,
  TaskToolBindingLive,
  IngestionLive,
)
