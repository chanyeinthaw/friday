/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, anti-slop/no-unsafe-dictionary-type -- Bun executes the SQLite integration boundary; SQL rows are decoded immediately. */

import { test } from 'bun:test'
import { PlatformConnectionId } from '@friday/contracts/conversation'
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { InvocationMode, type InvocationMode as InvocationModeType } from './AppConfig.ts'
import { loadAppConfig } from './AppConfig.ts'
import {
  DiscordGuildChannelId,
  DiscordGuildError,
  DiscordGuildId,
  DiscordGuilds,
  DiscordGuildsLive,
} from './DiscordGuilds.ts'
import { runMigrations } from '../persistence/Migrations.ts'
import { applyDiscordConfigMutation } from '../Cli.ts'
import { reloadFailed, reloadSucceeded } from './ConfigReload.ts'
import { sendControlRequest, serveControlSocket } from '../control/ControlSocket.ts'

const database = SqliteClient.layer({ filename: ':memory:' })
const guilds = DiscordGuildsLive.pipe(Layer.provide(database))
const databaseLayer = (filename: string) => SqliteClient.layer({ filename })
const guildLayer = (filename: string) => {
  const sqlite = databaseLayer(filename)
  return Layer.merge(DiscordGuildsLive.pipe(Layer.provide(sqlite)), sqlite)
}
const temporaryDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
  )
const decodeGuildId = Schema.decodeSync(DiscordGuildId)
const decodeChannelId = Schema.decodeSync(DiscordGuildChannelId)
const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
type ConnectionId = typeof PlatformConnectionId.Type
const decodeInvocationMode = Schema.decodeSync(InvocationMode)
const decodeMode = (mode: InvocationModeType): InvocationModeType => decodeInvocationMode(mode)
const isDiscordGuildError = Schema.is(DiscordGuildError)

const seed = Effect.gen(function* () {
  yield* runMigrations()
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    INSERT INTO platform_connections (
      connection_id, platform, name, enabled, created_at, updated_at
    ) VALUES
      ('discord', 'discord', 'Discord', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ('chat', 'slack', 'Slack', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `
  yield* sql`
    INSERT INTO discord_connections (
      connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions
    ) VALUES ('discord', 'application-1', 'public-key-1', 'DISCORD_BOT_TOKEN', 1)
  `
})

const installWriteAudit = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TEMP TABLE discord_guild_write_audit (table_name TEXT NOT NULL)`
  for (const table of [
    'discord_guilds',
    'discord_guild_users',
    'discord_guild_channel_scope',
    'discord_guild_channels',
    'discord_guild_channel_users',
  ]) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      yield* sql.unsafe(
        `CREATE TEMP TRIGGER audit_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN INSERT INTO discord_guild_write_audit (table_name) VALUES ('${table}'); END`,
      )
    }
  }
})

const writeAuditCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{ readonly count: number }>`
    SELECT count(*) AS count FROM discord_guild_write_audit
  `
  return rows[0]?.count ?? 0
})

test('manages guild enablement, defaults, and channel overrides', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      const store = yield* DiscordGuilds
      const connectionId = decodeConnectionId('discord')
      const guildId = decodeGuildId('111111111111111111')
      const channelId = decodeChannelId('222222222222222222')

      // Enabling creates a disabled-nothing guild with safe defaults; it is idempotent.
      assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'enabled')
      assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'already-enabled')
      const listed = yield* store.listGuilds(connectionId)
      assert.deepStrictEqual(listed, [
        {
          guildId: '111111111111111111',
          enabled: true,
          invocation: { defaultMode: 'mention-only' },
          channels: [],
        },
      ])

      // Guild-wide defaults update in place.
      assert.strictEqual(
        yield* store.setGuildInvocation(connectionId, guildId, decodeMode('all-messages')),
        'updated',
      )
      assert.strictEqual(
        yield* store.setGuildInvocation(connectionId, guildId, decodeMode('all-messages')),
        'unchanged',
      )
      assert.strictEqual(
        yield* store.setGuildUsers(connectionId, guildId, {
          mode: 'allow',
          ids: ['333333333333333333'],
        }),
        'updated',
      )
      assert.strictEqual(
        yield* store.setGuildUsers(connectionId, guildId, {
          mode: 'allow',
          ids: ['333333333333333333', '333333333333333333'],
        }),
        'unchanged',
      )
      assert.strictEqual(
        yield* store.setGuildUsers(connectionId, guildId, { mode: 'all', ids: [] }),
        'updated',
      )

      // The guild channel scope replaces its subjects in place.
      assert.strictEqual(
        yield* store.setGuildChannelScope(connectionId, guildId, {
          mode: 'allow',
          ids: ['222222222222222222', '777777777777777777'],
        }),
        'updated',
      )
      assert.strictEqual(
        yield* store.setGuildChannelScope(connectionId, guildId, {
          mode: 'allow',
          ids: ['777777777777777777', '222222222222222222'],
        }),
        'unchanged',
      )
      assert.deepStrictEqual(yield* store.listGuilds(connectionId), [
        {
          guildId: '111111111111111111',
          enabled: true,
          invocation: { defaultMode: 'all-messages' },
          users: { mode: 'all', ids: [] },
          channelScope: { mode: 'allow', ids: ['222222222222222222', '777777777777777777'] },
          channels: [],
        },
      ])
      assert.strictEqual(
        yield* store.setGuildChannelScope(connectionId, guildId, { mode: 'all', ids: [] }),
        'updated',
      )
      const scopeListed = yield* store.listGuilds(connectionId)
      assert.deepStrictEqual(scopeListed[0]?.channelScope, { mode: 'all', ids: [] })

      // Channel overrides merge: a later partial set preserves earlier fields.
      assert.strictEqual(
        yield* store.setChannel(connectionId, guildId, channelId, {
          users: { mode: 'deny', ids: ['444444444444444444'] },
        }),
        'updated',
      )
      assert.strictEqual(
        yield* store.setChannel(connectionId, guildId, channelId, {
          replyMode: 'reply-in-channel',
        }),
        'updated',
      )
      assert.strictEqual(
        yield* store.setChannel(connectionId, guildId, channelId, {
          users: { mode: 'deny', ids: ['444444444444444444'] },
          replyMode: 'reply-in-channel',
        }),
        'unchanged',
      )
      assert.strictEqual(yield* store.resetChannel(connectionId, guildId, channelId), 'removed')
      assert.strictEqual(yield* store.resetChannel(connectionId, guildId, channelId), 'missing')

      // A channel row needs an enabled guild to exist.
      const unknownGuild = decodeGuildId('555555555555555555')
      assert.strictEqual(
        yield* store.setChannel(connectionId, unknownGuild, channelId, {
          replyMode: 'reply-in-channel',
        }),
        'missing-guild',
      )

      // Disable and remove report idempotent outcomes and cascade overrides.
      assert.strictEqual(yield* store.disableGuild(connectionId, guildId), 'disabled')
      assert.strictEqual(yield* store.disableGuild(connectionId, guildId), 'already-disabled')
      assert.strictEqual(yield* store.enableGuild(connectionId, guildId), 'enabled')
      assert.strictEqual(
        yield* store.setChannel(connectionId, guildId, channelId, {
          replyMode: 'reply-in-channel',
        }),
        'updated',
      )
      assert.strictEqual(yield* store.removeGuild(connectionId, guildId), 'removed')
      assert.strictEqual(yield* store.removeGuild(connectionId, guildId), 'missing')
      const afterRemove = yield* store.listGuilds(connectionId)
      assert.deepStrictEqual(afterRemove, [])
      const sql = yield* SqlClient.SqlClient
      const orphanChannels = yield* sql<Record<string, unknown>>`
        SELECT * FROM discord_guild_channels WHERE connection_id = 'discord'
      `
      assert.deepStrictEqual(orphanChannels, [])

      // Missing guild updates report `missing` instead of failing.
      assert.strictEqual(
        yield* store.setGuildInvocation(connectionId, guildId, decodeMode('mention-only')),
        'missing',
      )
      assert.strictEqual(yield* store.disableGuild(connectionId, guildId), 'missing')
    }).pipe(Effect.provide(Layer.merge(guilds, database))),
  ))

test('joins a committed guild write to the real control socket reload exchange', async () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory('friday-guild-reload-')
        const filename = join(directory, 'friday.sqlite')
        const path = join(directory, 'friday.sock')
        const connectionId = decodeConnectionId('discord')
        const guildId = decodeGuildId('111111111111111111')

        yield* Effect.gen(function* () {
          yield* seed
          const store = yield* DiscordGuilds
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* serveControlSocket({
                path,
                reload: store.listGuilds(connectionId).pipe(
                  Effect.map((configured) => {
                    assert.strictEqual(configured[0]?.guildId, guildId)
                    return reloadSucceeded(7)
                  }),
                  Effect.orDie,
                ),
              })
              const result = yield* applyDiscordConfigMutation(
                store.enableGuild(connectionId, guildId),
                (outcome) => outcome === 'enabled',
                sendControlRequest(path, { op: 'config.reload' }),
              )
              assert.deepStrictEqual(result, {
                outcome: 'enabled',
                application: { _tag: 'reloaded', version: 7 },
              })
            }),
          )
        }).pipe(Effect.provide(guildLayer(filename)))

        const reopened = yield* Effect.gen(function* () {
          const store = yield* DiscordGuilds
          return yield* store.listGuilds(connectionId)
        }).pipe(Effect.provide(guildLayer(filename)))
        assert.strictEqual(reopened[0]?.guildId, guildId)
      }),
    ),
  ))

test('preserves committed guild writes when the socket is offline or rejects reload', async () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory('friday-guild-reload-')
        const filename = join(directory, 'friday.sqlite')
        const path = join(directory, 'friday.sock')
        const connectionId = decodeConnectionId('discord')
        const offlineGuild = decodeGuildId('111111111111111111')
        const rejectedGuild = decodeGuildId('222222222222222222')

        yield* Effect.gen(function* () {
          yield* seed
          const store = yield* DiscordGuilds
          const offline = yield* applyDiscordConfigMutation(
            store.enableGuild(connectionId, offlineGuild),
            (outcome) => outcome === 'enabled',
            sendControlRequest(path, { op: 'config.reload' }),
          )
          assert.deepStrictEqual(offline, {
            outcome: 'enabled',
            application: { _tag: 'next-startup' },
          })

          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* serveControlSocket({
                path,
                reload: store.listGuilds(connectionId).pipe(
                  Effect.map((configured) => {
                    assert(configured.some((guild) => guild.guildId === rejectedGuild))
                    return reloadFailed('Stored Friday configuration is invalid.')
                  }),
                  Effect.orDie,
                ),
              })
              const rejected = yield* applyDiscordConfigMutation(
                store.enableGuild(connectionId, rejectedGuild),
                (outcome) => outcome === 'enabled',
                sendControlRequest(path, { op: 'config.reload' }),
              )
              assert.deepStrictEqual(rejected, {
                outcome: 'enabled',
                application: {
                  _tag: 'rejected',
                  detail: 'Stored Friday configuration is invalid.',
                },
              })
            }),
          )
        }).pipe(Effect.provide(guildLayer(filename)))

        const reopened = yield* Effect.gen(function* () {
          const store = yield* DiscordGuilds
          return yield* store.listGuilds(connectionId)
        }).pipe(Effect.provide(guildLayer(filename)))
        assert(reopened.some((guild) => guild.guildId === offlineGuild))
        assert(reopened.some((guild) => guild.guildId === rejectedGuild))
      }),
    ),
  ))

test('identical guild setters perform no SQLite writes', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      const store = yield* DiscordGuilds
      const connectionId = decodeConnectionId('discord')
      const guildId = decodeGuildId('111111111111111111')
      const channelId = decodeChannelId('222222222222222222')
      yield* store.enableGuild(connectionId, guildId)
      yield* store.setGuildInvocation(connectionId, guildId, decodeMode('all-messages'))
      yield* store.setGuildUsers(connectionId, guildId, {
        mode: 'allow',
        ids: ['333333333333333333'],
      })
      yield* store.setGuildChannelScope(connectionId, guildId, {
        mode: 'allow',
        ids: ['222222222222222222'],
      })
      yield* store.setChannel(connectionId, guildId, channelId, {
        invocationMode: decodeMode('all-messages'),
        users: { mode: 'deny', ids: ['444444444444444444'] },
        replyMode: 'reply-in-channel',
      })
      yield* installWriteAudit

      const unchanged = [
        store.setGuildInvocation(connectionId, guildId, decodeMode('all-messages')),
        store.setGuildUsers(connectionId, guildId, {
          mode: 'allow',
          ids: ['333333333333333333', '333333333333333333'],
        }),
        store.setGuildChannelScope(connectionId, guildId, {
          mode: 'allow',
          ids: ['222222222222222222', '222222222222222222'],
        }),
        store.setChannel(connectionId, guildId, channelId, {
          invocationMode: decodeMode('all-messages'),
          users: { mode: 'deny', ids: ['444444444444444444'] },
          replyMode: 'reply-in-channel',
        }),
      ] as const
      for (const mutation of unchanged) assert.strictEqual(yield* mutation, 'unchanged')
      assert.strictEqual(yield* writeAuditCount, 0)
    }).pipe(Effect.provide(Layer.merge(guilds, database))),
  ))

test('every guild mutation rejects unknown and non-Discord connections with typed errors', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      const store = yield* DiscordGuilds
      const guildId = decodeGuildId('111111111111111111')
      const channelId = decodeChannelId('222222222222222222')

      // One entry per public mutation; arguments are otherwise irrelevant
      // because the connection guard must fire before any write.
      const mutations = [
        ['enableGuild', (c: ConnectionId) => store.enableGuild(c, guildId)],
        ['disableGuild', (c: ConnectionId) => store.disableGuild(c, guildId)],
        ['removeGuild', (c: ConnectionId) => store.removeGuild(c, guildId)],
        [
          'setGuildInvocation',
          (c: ConnectionId) => store.setGuildInvocation(c, guildId, decodeMode('mention-only')),
        ],
        [
          'setGuildUsers',
          (c: ConnectionId) => store.setGuildUsers(c, guildId, { mode: 'all', ids: [] }),
        ],
        [
          'setGuildChannelScope',
          (c: ConnectionId) => store.setGuildChannelScope(c, guildId, { mode: 'all', ids: [] }),
        ],
        [
          'setChannel',
          (c: ConnectionId) =>
            store.setChannel(c, guildId, channelId, { replyMode: 'reply-in-channel' }),
        ],
        ['resetChannel', (c: ConnectionId) => store.resetChannel(c, guildId, channelId)],
      ] as const
      const scenarios = [
        ['unknown connection', decodeConnectionId('missing'), 'unknown-connection'],
        ['non-Discord connection', decodeConnectionId('chat'), 'non-discord-connection'],
      ] as const

      for (const [scenario, connectionId, expectedOperation] of scenarios) {
        for (const [name, mutate] of mutations) {
          const error = yield* Effect.flip(mutate(connectionId))
          assert(
            isDiscordGuildError(error),
            `${name} must fail with a typed DiscordGuildError for a ${scenario}`,
          )
          assert.strictEqual(error.operation, expectedOperation, `${name} for a ${scenario}`)
        }
      }

      // The rejections fired before any write touched the real connection.
      assert.deepStrictEqual(yield* store.listGuilds(decodeConnectionId('discord')), [])
    }).pipe(Effect.provide(Layer.merge(guilds, database))),
  ))

test('configured guilds flow into the loaded application configuration', async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* seed
      const store = yield* DiscordGuilds
      const connectionId = decodeConnectionId('discord')
      yield* store.enableGuild(connectionId, decodeGuildId('111111111111111111'))
      yield* store.setGuildInvocation(
        connectionId,
        decodeGuildId('111111111111111111'),
        decodeMode('all-messages'),
      )
      yield* store.setGuildUsers(connectionId, decodeGuildId('111111111111111111'), {
        mode: 'allow',
        ids: ['333333333333333333'],
      })
      yield* store.setChannel(
        connectionId,
        decodeGuildId('111111111111111111'),
        decodeChannelId('222222222222222222'),
        { replyMode: 'reply-in-channel' },
      )
      yield* store.setGuildChannelScope(connectionId, decodeGuildId('111111111111111111'), {
        mode: 'deny',
        ids: ['888888888888888888'],
      })

      const config = yield* loadAppConfig({ environment: { DISCORD_BOT_TOKEN: 'token' } })
      const discord = config.platforms.discord[0]
      assert(discord !== undefined)
      assert.deepStrictEqual(discord.guilds, [
        {
          guildId: '111111111111111111',
          enabled: true,
          invocation: { defaultMode: 'all-messages' },
          users: { mode: 'allow', ids: ['333333333333333333'] },
          channelScope: { mode: 'deny', ids: ['888888888888888888'] },
          channels: [{ channelId: '222222222222222222', replyMode: 'reply-in-channel' }],
        },
      ])
    }).pipe(Effect.provide(Layer.merge(guilds, database))),
  ))
