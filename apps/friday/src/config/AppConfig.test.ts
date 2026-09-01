import { assert, it } from '@effect/vitest'
import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import {
  AppConfig,
  DiscordPlatformConfig,
  findDiscordConnection,
  mergeReloadedAppConfig,
} from './AppConfig.ts'

const decodeAppConfig = Schema.decodeSync(AppConfig)
const decodeDiscord = Schema.decodeSync(DiscordPlatformConfig)

const guild = (
  overrides: {
    readonly guildId?: string
    readonly enabled?: boolean
    readonly invocationMode?: 'mention-only' | 'all-messages'
    readonly channels?: DiscordPlatformConfig['guilds'][number]['channels']
  } = {},
) => ({
  guildId: overrides.guildId ?? '111111111111111111',
  enabled: overrides.enabled ?? true,
  invocation: { defaultMode: overrides.invocationMode ?? 'mention-only' },
  channels: overrides.channels ?? [],
})

const discordConnection = (overrides: {
  readonly connectionId?: string
  readonly botToken?: string
  readonly mentionRoleIds?: ReadonlyArray<string>
  readonly users?: { readonly mode: 'all' | 'allow' | 'deny'; readonly ids: ReadonlyArray<string> }
  readonly guilds?: ReadonlyArray<ReturnType<typeof guild>>
}) =>
  decodeDiscord({
    connectionId: overrides.connectionId ?? 'discord-personal',
    platform: 'discord',
    name: 'Personal Discord',
    credentials: {
      botToken: overrides.botToken ?? 'token-1',
      applicationId: 'application-1',
      publicKey: 'public-key-1',
    },
    users: overrides.users ?? { mode: 'all', ids: [] },
    respondToGlobalMentions: true,
    mentionRoleIds: overrides.mentionRoleIds ?? ['role-1'],
    activityDescription: false,
    guilds: overrides.guilds ?? [guild()],
  })

const appConfig = (discord: ReadonlyArray<ReturnType<typeof discordConnection>>) =>
  decodeAppConfig({
    installationId: 'installation-1',
    models: {
      primary: { provider: 'opencode-go', modelId: 'glm-5.3-flash', thinkingLevel: 'medium' },
      utility: { provider: 'opencode-go', modelId: 'glm-5.3-flash', thinkingLevel: 'low' },
      subagents: [],
    },
    platforms: { discord, slack: [] },
    agent: { recentMessageCount: 20 },
    admin: { discordUserIds: ['admin-1'] },
  })

it('applies reloaded guild configuration and user policies to running connections', () => {
  const running = appConfig([discordConnection({})])
  const loaded = appConfig([
    discordConnection({
      users: { mode: 'allow', ids: ['user-1'] },
      guilds: [guild({ invocationMode: 'all-messages' }), guild({ guildId: '222222222222222222' })],
    }),
  ])
  const merged = mergeReloadedAppConfig(running, loaded)
  const connection = merged.platforms.discord[0]
  assert(connection)
  assert.deepStrictEqual(connection.users, { mode: 'allow', ids: ['user-1'] })
  assert.strictEqual(connection.guilds.length, 2)
  assert.strictEqual(connection.guilds[0]?.invocation.defaultMode, 'all-messages')
})

it('pins credentials, mention roles, and other restart-based Discord topology', () => {
  const running = appConfig([discordConnection({ botToken: 'running-token' })])
  const loaded = appConfig([
    discordConnection({
      botToken: 'database-token',
      mentionRoleIds: ['role-2'],
    }),
  ])
  const merged = mergeReloadedAppConfig(running, loaded)
  const connection = merged.platforms.discord[0]
  assert(connection)
  assert.strictEqual(String(connection.credentials.botToken), 'running-token')
  assert.deepStrictEqual([...connection.mentionRoleIds], ['role-1'])
})

it('keeps running connections that disappeared from the loaded configuration', () => {
  const running = appConfig([
    discordConnection({ connectionId: 'discord-personal' }),
    discordConnection({ connectionId: 'discord-work', botToken: 'token-2' }),
  ])
  const loaded = appConfig([discordConnection({ connectionId: 'discord-personal' })])
  const merged = mergeReloadedAppConfig(running, loaded)
  assert.strictEqual(merged.platforms.discord.length, 2)
  assert.strictEqual(merged.platforms.discord[1]?.connectionId, 'discord-work')
})

it('ignores newly added Discord connections until restart', () => {
  const running = appConfig([discordConnection({ connectionId: 'discord-personal' })])
  const loaded = appConfig([
    discordConnection({ connectionId: 'discord-personal' }),
    discordConnection({ connectionId: 'discord-new' }),
  ])
  const merged = mergeReloadedAppConfig(running, loaded)
  assert.strictEqual(merged.platforms.discord.length, 1)
})

it('pins the admin allow-list to the running snapshot', () => {
  const running = appConfig([])
  const loaded = appConfig([])
  const withAdmin = decodeAppConfig({ ...loaded, admin: { discordUserIds: ['admin-2'] } })
  const merged = mergeReloadedAppConfig(running, withAdmin)
  assert.deepStrictEqual([...merged.admin.discordUserIds], ['admin-1'])
})

it('takes non-topology configuration from the loaded snapshot', () => {
  const running = appConfig([])
  const loaded = decodeAppConfig({
    ...appConfig([]),
    agent: { recentMessageCount: 40 },
    models: {
      primary: {
        provider: 'opencode-go',
        modelId: 'glm-5.3-flash',
        thinkingLevel: 'high',
      },
      utility: { provider: 'opencode-go', modelId: 'glm-5.3-flash', thinkingLevel: 'low' },
      subagents: [],
    },
  })
  const merged = mergeReloadedAppConfig(running, loaded)
  assert.strictEqual(merged.agent.recentMessageCount, 40)
  assert.strictEqual(merged.models.primary.thinkingLevel, 'high')
})

it('finds a running Discord connection by ID', () => {
  const running = appConfig([discordConnection({ connectionId: 'discord-personal' })])
  const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
  const found = findDiscordConnection(running, decodeConnectionId('discord-personal'))
  assert(Option.isSome(found))
  const missing = findDiscordConnection(running, decodeConnectionId('discord-unknown'))
  assert(Option.isNone(missing))
})
