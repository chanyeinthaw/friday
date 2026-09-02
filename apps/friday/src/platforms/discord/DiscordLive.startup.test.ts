/* oxlint-disable effecttsgo/strict-effect-provide, typescript/no-unsafe-type-assertion -- This test supplies narrow service records for dependencies that startDiscord acquires but does not call before the injected lifecycle boundary. */

import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import { assert, it } from '@effect/vitest'
import { ModelSelection } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import { DiscordPlatformConfig, type AppConfig as AppConfigData } from '../../config/AppConfig.ts'
import { AppConfig } from '../../config/AppConfigLive.ts'
import { DiscordActivityDescriptions } from '../DiscordActivityDescriptions.ts'
import { PlatformIngestion } from '../PlatformIngestion.ts'
import { PlatformRegistry } from '../PlatformRegistry.ts'
import { ThreadPersistence } from '../../conversation/ThreadPersistence.ts'
import { ThreadRuntimePool } from '../../conversation/ThreadRuntimePool.ts'
import { DiscordLinkHandoffs } from './DiscordLinkHandoffs.ts'
import { startDiscord } from './DiscordLive.ts'
import { DiscordCapabilityRegistry } from './DiscordLinkedRuntime.ts'

const decodeConnection = Schema.decodeSync(DiscordPlatformConfig)
const connection = (id: string) =>
  decodeConnection({
    connectionId: id,
    platform: 'discord',
    name: id,
    credentials: {
      botToken: `token-${id}`,
      applicationId: `application-${id}`,
      publicKey: `public-${id}`,
    },
    respondToGlobalMentions: false,
    mentionRoleIds: [],
    activityDescription: false,
    users: { mode: 'deny', ids: [] },
    guilds: [],
  })

const decodeModel = Schema.decodeSync(ModelSelection)
const primaryModel = decodeModel({ provider: 'test', modelId: 'primary' })
const utilityModel = decodeModel({ provider: 'test', modelId: 'utility' })

const configuration: AppConfigData = {
  installationId: 'startup-test',
  models: {
    primary: { ...primaryModel, thinkingLevel: 'low' },
    utility: { ...utilityModel, thinkingLevel: 'low' },
    subagents: [],
  },
  platforms: { discord: [connection('discord-a'), connection('discord-b')], slack: [] },
  discordLinks: [],
  agent: { recentMessageCount: 20 },
  admin: { discordUserIds: [] },
}

// SAFETY: startPrepared exits before startDiscord calls these services. The test
// supplies them only because the production function acquires them up front.
const baseLayer = Layer.mergeAll(
  SqliteClient.layer({ filename: ':memory:' }),
  NodeCrypto.layer,
  NodeFileSystem.layer,
  Layer.succeed(AppConfig, { current: () => configuration, reload: Effect.succeed(1) }),
  Layer.succeed(PlatformRegistry, {} as never),
  Layer.succeed(DiscordActivityDescriptions, {} as never),
  Layer.succeed(PlatformIngestion, {} as never),
  Layer.succeed(DiscordLinkHandoffs, { handoff: () => Effect.void }),
  Layer.succeed(ThreadPersistence, {} as never),
  Layer.succeed(ThreadRuntimePool, {
    open: () => Effect.die('not used'),
    cancel: () => Effect.die('not used'),
    steer: () => Effect.die('not used'),
    reloadHarness: () => Effect.die('not used'),
    events: Stream.empty,
  } as never),
)

it.effect('registers every real adapter capability before startDiscord begins any lifecycle', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const registered: Array<{
        readonly connectionId: string
        readonly postSafe: unknown
      }> = []
      const registry = DiscordCapabilityRegistry.of({
        register: (capability) =>
          Effect.sync(() => {
            registered.push({
              connectionId: String(capability.connectionId),
              postSafe: capability.postSafe,
            })
            events.push(`register:${capability.connectionId}`)
          }),
        get: () => Effect.die('not used'),
      })
      yield* startDiscord({
        startPrepared: ({ connectionId }) =>
          Effect.sync(() => {
            events.push(`start:${connectionId}`)
          }),
      }).pipe(
        Effect.provide(baseLayer),
        Effect.provide(Layer.succeed(DiscordCapabilityRegistry, registry)),
      )

      const firstStart = events.findIndex((event) => event.startsWith('start:'))
      assert.deepStrictEqual(events.filter((event) => event.startsWith('register:')).toSorted(), [
        'register:discord-a',
        'register:discord-b',
      ])
      assert.deepStrictEqual(registered.map(({ connectionId }) => connectionId).toSorted(), [
        'discord-a',
        'discord-b',
      ])
      assert.strictEqual(
        registered.every(({ postSafe }) => postSafe !== undefined),
        true,
      )
      assert.strictEqual(firstStart, 2)
      assert.deepStrictEqual(events.filter((event) => event.startsWith('start:')).toSorted(), [
        'start:discord-a',
        'start:discord-b',
      ])
    }),
  ),
)

it.effect('starts no lifecycle when startDiscord preparation or registration fails', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const registry = DiscordCapabilityRegistry.of({
        register: (capability): Effect.Effect<void> =>
          capability.connectionId === 'discord-b'
            ? Effect.die('registration failed')
            : Effect.sync(() => {
                events.push(`register:${capability.connectionId}`)
              }),
        get: () => Effect.die('not used'),
      })
      const exit = yield* startDiscord({
        startPrepared: ({ connectionId }) =>
          Effect.sync(() => {
            events.push(`start:${connectionId}`)
          }),
      }).pipe(
        Effect.provide(baseLayer),
        Effect.provide(Layer.succeed(DiscordCapabilityRegistry, registry)),
        Effect.exit,
      )

      assert.strictEqual(exit._tag, 'Failure')
      assert.deepStrictEqual(
        events.filter((event) => event.startsWith('start:')),
        [],
      )
    }),
  ),
)
