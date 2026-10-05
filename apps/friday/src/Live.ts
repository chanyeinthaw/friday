import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import * as BunFileSystem from '@effect/platform-bun/BunFileSystem'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import type { Storage } from '@earendil-works/pi-durable'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { FridayLive as FridayServiceLive } from './Friday.ts'
import { ChannelProgress, ChannelProgressLive } from './conversation/ChannelProgress.ts'
import { ChannelTurnsLive } from './conversation/ChannelTurns.ts'
import { AppConfig, AppConfigLive } from './config/AppConfigLive.ts'
import {
  DefaultIdentityText,
  IdentityConfiguration,
  IdentityConfigurationLive,
} from './config/IdentityConfiguration.ts'
import { RootUsers, RootUsersLive } from './config/RootUsers.ts'
import { rootUsersForBinding as selectRootUsersForBinding } from './identity/RootUsers.ts'
import { PiModelRuntime, PiModelRuntimeLive } from './harness/pi/Live.ts'
import { makePiTextGeneration } from './harness/pi/PiTextGeneration.ts'
import { makePiPlatformThreadRouter } from './harness/pi/PiPlatformThreadRouter.ts'
import { TextGeneration } from './harness/TextGeneration.ts'
import { PlatformThreadRouter } from './platforms/PlatformThreadRouter.ts'
import { PiDurable, makePiDurable } from './harness/pi/PiDurable.ts'
import { makePiSqliteStorage } from '@friday/pi-durable-effect/sqlite'
import { FRIDAY_HOME } from './FridayHome.ts'
import { ThreadPersistence } from './conversation/ThreadPersistence.ts'
import { FridayHomeLive, FridaySqliteLive, ThreadPersistenceLive } from './persistence/Live.ts'
import { ConversationTitles, ConversationTitlesLive } from './platforms/ConversationTitles.ts'
import { PlatformIngestionLive } from './platforms/PlatformIngestion.ts'
import { PlatformRegistry, PlatformRegistryLive } from './platforms/PlatformRegistry.ts'
import {
  SystemPromptTemplates,
  SystemPromptTemplatesLive,
} from './system-prompt/SystemPromptTemplates.ts'
import { makeTaskModels, TaskModels } from './tasks/TaskModels.ts'
import { TaskToolDispatcher, TaskToolDispatcherLive } from './tasks/TaskToolDispatcher.ts'
import { Tasks, TasksLive } from './tasks/Tasks.ts'

const AppConfigConfiguredLive = AppConfigLive.pipe(Layer.provide(FridaySqliteLive))
const IdentityConfigurationConfiguredLive = IdentityConfigurationLive.pipe(
  Layer.provide(FridaySqliteLive),
)
const RootUsersConfiguredLive = RootUsersLive.pipe(Layer.provide(FridaySqliteLive))

const CoreLive = Layer.mergeAll(
  ThreadPersistenceLive,
  PiModelRuntimeLive,
  BunCrypto.layer,
  BunFileSystem.layer,
  PlatformRegistryLive,
  AppConfigConfiguredLive,
  IdentityConfigurationConfiguredLive,
  RootUsersConfiguredLive,
  SystemPromptTemplatesLive,
  TaskToolDispatcherLive,
)

const TextGenerationLive = Layer.effect(TextGeneration, makePiTextGeneration()).pipe(
  Layer.provide(CoreLive),
)
const PlatformThreadRouterConfiguredLive = Layer.effect(
  PlatformThreadRouter,
  makePiPlatformThreadRouter(),
).pipe(Layer.provide(CoreLive))
const ConversationTitlesConfiguredLive = ConversationTitlesLive.pipe(Layer.provide(CoreLive))
const ChannelProgressConfiguredLive = ChannelProgressLive.pipe(Layer.provide(CoreLive))
class PiStorage extends Context.Service<PiStorage, Storage>()('friday/pi/Storage') {}
const PiStorageLive = Layer.effect(PiStorage, makePiSqliteStorage().pipe(Effect.orDie)).pipe(
  Layer.provide(
    SqliteClient.layer({ filename: `${FRIDAY_HOME}/pi-durable.sqlite` }).pipe(
      Layer.provide(FridayHomeLive),
    ),
  ),
)
const RuntimeLive = Layer.effect(
  PiDurable,
  Effect.gen(function* () {
    const models = yield* PiModelRuntime
    const persistence = yield* ThreadPersistence
    const progress = yield* ChannelProgress
    const tasks = yield* TaskToolDispatcher
    const platforms = yield* PlatformRegistry
    const templates = yield* SystemPromptTemplates
    const config = yield* AppConfig
    const identity = yield* IdentityConfiguration
    const rootUsers = yield* RootUsers
    const conversationTitles = yield* ConversationTitles
    return yield* makePiDurable({
      storage: yield* PiStorage,
      models,
      persistence,
      progress,
      tasks,
      platforms,
      templates,
      availableAgentModels: () => config.current().models.subagents,
      identityText: () => identity.get().pipe(Effect.orElseSucceed(() => DefaultIdentityText)),
      rootUsers: (thread) =>
        rootUsers.list().pipe(
          Effect.map((users) => selectRootUsersForBinding(users, thread.conversationBinding)),
          Effect.orElseSucceed(() => []),
        ),
      conversationTitles,
    })
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      CoreLive,
      PiStorageLive,
      ChannelProgressConfiguredLive,
      ConversationTitlesConfiguredLive,
    ),
  ),
)
const AgentLive = FridayServiceLive.pipe(Layer.provide(RuntimeLive))
const ChannelTurnsConfiguredLive = ChannelTurnsLive.pipe(
  Layer.provide(Layer.mergeAll(CoreLive, AgentLive)),
)
const TaskModelsConfiguredLive = Layer.effect(
  TaskModels,
  Effect.gen(function* () {
    const config = yield* AppConfig
    return makeTaskModels(() => config.current().models.subagents)
  }),
).pipe(Layer.provide(CoreLive))
const TasksConfiguredLive = TasksLive.pipe(
  Layer.provide(Layer.mergeAll(CoreLive, AgentLive, TaskModelsConfiguredLive)),
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
  AgentLive,
  TextGenerationLive,
  PlatformThreadRouterConfiguredLive,
  ConversationTitlesConfiguredLive,
  ChannelProgressConfiguredLive,
  ChannelTurnsConfiguredLive,
  TaskModelsConfiguredLive,
  TasksConfiguredLive,
  TaskToolBindingLive,
  IngestionLive,
)
