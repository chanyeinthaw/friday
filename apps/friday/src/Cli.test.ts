import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as TestConsole from 'effect/testing/TestConsole'

import {
  ConfigReloadRejectedError,
  FridayCliError,
  FRIDAY_VERSION,
  formatDiscordAdminAdd,
  formatDiscordAdminRemove,
  formatDiscordConnectionAdd,
  formatDiscordConnectionDisable,
  formatDiscordConnectionEnable,
  formatDiscordConnectionRemove,
  formatDiscordConnectionUpdate,
  formatDiscordGuildChannelReset,
  formatDiscordGuildChannelSet,
  formatDiscordGuildChannels,
  formatDiscordGuildDisable,
  formatDiscordGuildEnable,
  formatDiscordGuildInvocation,
  formatDiscordGuildRemove,
  formatDiscordGuildUsers,
  cliCommandSpec,
  findCommandSpec,
  isCliBranch,
  isCliRemoved,
  parseAccessPolicySpec,
  parseFridayCli,
  renderCliHelp,
  renderDiscordAdminList,
  renderDiscordConnectionDetail,
  renderDiscordConnectionList,
  renderDiscordGuildList,
  renderWorktreeList,
  renderWorkspaceCleanupList,
  runFridayCli,
} from './Cli.ts'
import type { CliCommandSpec } from './Cli.ts'
import { DiscordGuildChannelId, DiscordGuildId } from './config/DiscordGuilds.ts'
import { BotTokenEnvName, DiscordPublicKey } from './config/DiscordConnections.ts'
import { InvocationMode } from './config/AppConfig.ts'
import { reloadFailed, reloadSucceeded } from './config/ConfigReload.ts'
import { DiscordUserId } from './config/DiscordAdmins.ts'
import { ControlSocketError } from './control/ControlSocket.ts'
import {
  ModelId,
  PlatformConnectionId,
  ProviderId,
  SubagentProfileName,
  ThreadId,
} from '@friday/contracts/conversation'
import { RepositoryUrl } from './repositories/RepositoryWorktrees.ts'
import { WorkspaceCleanupProposalId } from './workspaces/WorkspaceCleanup.ts'

const isFridayCliError = Schema.is(FridayCliError)
const isConfigReloadRejectedError = Schema.is(ConfigReloadRejectedError)
const isControlSocketError = Schema.is(ControlSocketError)
const decodeRepositoryUrl = Schema.decodeSync(RepositoryUrl)
const decodeCleanupProposalId = Schema.decodeSync(WorkspaceCleanupProposalId)
const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeProviderId = Schema.decodeSync(ProviderId)
const decodeModelId = Schema.decodeSync(ModelId)
const decodeProfileName = Schema.decodeSync(SubagentProfileName)
const decodeThreadId = Schema.decodeSync(ThreadId)
const decodeDiscordUserId = Schema.decodeSync(DiscordUserId)
const decodeGuildId = Schema.decodeSync(DiscordGuildId)
const decodeChannelId = Schema.decodeSync(DiscordGuildChannelId)
const decodeMode = Schema.decodeSync(InvocationMode)
const decodePublicKey = Schema.decodeSync(DiscordPublicKey)
const decodeBotTokenEnv = Schema.decodeSync(BotTokenEnvName)

/**
 * Base runner whose every operation dies loudly: dispatch tests override
 * exactly the one operation a command is expected to reach, so any extra
 * dispatch fails the test.
 */
const strictRunnerStubs = {
  start: Effect.die('start must not run'),
  reloadConfig: Effect.die('unreachable'),
  listConfiguredModels: () => Effect.die('unreachable'),
  getConfiguredModel: () => Effect.die('unreachable'),
  setConfiguredModel: () => Effect.die('unreachable'),
  listSubagentProfiles: () => Effect.die('unreachable'),
  getSubagentProfile: () => Effect.die('unreachable'),
  addSubagentProfile: () => Effect.die('unreachable'),
  updateSubagentProfile: () => Effect.die('unreachable'),
  removeSubagentProfile: () => Effect.die('unreachable'),
  listPiModels: () => Effect.die('unreachable'),
  getPiModel: () => Effect.die('unreachable'),
  reloadPiModels: () => Effect.die('unreachable'),
  ensureWorktree: () => Effect.die('unreachable'),
  listWorktrees: () => Effect.die('unreachable'),
  setDiscordActivityDescription: () => Effect.die('unreachable'),
  applyWorkspaceCleanup: () => Effect.die('unreachable'),
  listWorkspaceCleanupProposals: () => Effect.die('unreachable'),
  addDiscordAdmin: () => Effect.die('unreachable'),
  removeDiscordAdmin: () => Effect.die('unreachable'),
  listDiscordAdmins: () => Effect.die('unreachable'),
  addDiscordConnection: () => Effect.die('unreachable'),
  updateDiscordConnection: () => Effect.die('unreachable'),
  removeDiscordConnection: () => Effect.die('unreachable'),
  enableDiscordConnection: () => Effect.die('unreachable'),
  disableDiscordConnection: () => Effect.die('unreachable'),
  getDiscordConnection: () => Effect.die('unreachable'),
  listDiscordConnections: () => Effect.die('unreachable'),
  listDiscordGuilds: () => Effect.die('unreachable'),
  enableDiscordGuild: () => Effect.die('unreachable'),
  disableDiscordGuild: () => Effect.die('unreachable'),
  removeDiscordGuild: () => Effect.die('unreachable'),
  setDiscordGuildInvocation: () => Effect.die('unreachable'),
  setDiscordGuildUsers: () => Effect.die('unreachable'),
  setDiscordGuildChannels: () => Effect.die('unreachable'),
  setDiscordGuildChannel: () => Effect.die('unreachable'),
  resetDiscordGuildChannel: () => Effect.die('unreachable'),
}

/**
 * Wraps one runner operation in a recorder so a dispatch test can assert the
 * exact calls (decoded arguments) that reached it. `outcome` is what the
 * operation replies; the arguments are captured verbatim.
 */
const recorder = <O>(outcome: O) => {
  const calls: Array<ReadonlyArray<unknown>> = []
  return {
    calls,
    operation: (...arguments_: ReadonlyArray<unknown>): Effect.Effect<O, never> =>
      Effect.sync(() => {
        calls.push(arguments_)
        return outcome
      }),
  }
}

/** The most recent printed line, for output assertions after one command. */
const decodeLine = Schema.decodeUnknownSync(Schema.String)
const decodeJsonNull = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Null))
const lastLine = Effect.map(TestConsole.logLines, (lines) =>
  decodeLine(lines[lines.length - 1] ?? ''),
)

it.effect('uses start as the default command', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli([]), { type: 'start' })
    assert.deepStrictEqual(yield* parseFridayCli(['start']), { type: 'start' })
  }),
)

it.effect('recognizes help without starting Friday', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['--help']), { type: 'help', topic: [] })
    assert.deepStrictEqual(yield* parseFridayCli(['-h']), { type: 'help', topic: [] })
  }),
)

it.effect('recognizes version without starting Friday', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['--version']), { type: 'version' })
    assert.deepStrictEqual(yield* parseFridayCli(['-v']), { type: 'version' })
  }),
)

it.effect('parses managed worktree options', () =>
  Effect.gen(function* () {
    const url = decodeRepositoryUrl('git@github.com:one-terrace/timezone-relay-bot.git')
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'worktree',
        'ensure',
        'git@github.com:one-terrace/timezone-relay-bot.git',
        '--workspace',
        '/tmp/channel',
        '--ref',
        'main',
        '--json',
      ]),
      {
        type: 'worktree-ensure',
        url,
        workspace: '/tmp/channel',
        ref: 'main',
        json: true,
      },
    )
  }),
)

it.effect('parses typed Discord connection lifecycle commands', () =>
  Effect.gen(function* () {
    const connectionId = decodeConnectionId('discord-main')
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'connection',
        'add',
        'discord-main',
        '--name',
        'Main bot',
        '--application-id',
        '111111111111111111',
        '--public-key',
        '0123456789abcdef'.repeat(4),
        '--bot-token-env',
        'FRIDAY_DISCORD_TOKEN',
        '--respond-to-global-mentions',
      ]),
      {
        type: 'config-discord-connection-add',
        connectionId,
        name: 'Main bot',
        applicationId: decodeGuildId('111111111111111111'),
        publicKey: decodePublicKey('0123456789abcdef'.repeat(4)),
        botTokenEnv: decodeBotTokenEnv('FRIDAY_DISCORD_TOKEN'),
        respondToGlobalMentions: true,
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'discord', 'connection', 'remove', 'discord-main', '--yes']),
      { type: 'config-discord-connection-remove', connectionId, yes: true },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'discord', 'connection', 'enable', 'discord-main']),
      { type: 'config-discord-connection-enable', connectionId },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'discord', 'connection', 'disable', 'discord-main']),
      { type: 'config-discord-connection-disable', connectionId },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'discord', 'connection', 'get', 'discord-main', '--json']),
      { type: 'config-discord-connection-get', connectionId, json: true },
    )
  }),
)

it.effect('rejects Discord connection secrets and unsafe removal', () =>
  Effect.gen(function* () {
    const commands = [
      ['config', 'discord', 'connection', 'remove', 'discord-main'],
      [
        'config',
        'discord',
        'connection',
        'add',
        'discord-main',
        '--name',
        'Main bot',
        '--application-id',
        '111111111111111111',
        '--public-key',
        '0123456789abcdef'.repeat(4),
        '--bot-token-env',
        'actual bot token with spaces',
      ],
    ]
    for (const command of commands) {
      const error = yield* parseFridayCli(command).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected typed failure: ${command.join(' ')}`)
    }
  }),
)

it.effect('parses Discord guild management commands', () =>
  Effect.gen(function* () {
    const connectionId = decodeConnectionId('discord')
    const guildId = decodeGuildId('111111111111111111')
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'enable',
        'discord',
        '111111111111111111',
      ]),
      { type: 'config-discord-guild-enable', connectionId, guildId },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'disable',
        'discord',
        '111111111111111111',
      ]),
      { type: 'config-discord-guild-disable', connectionId, guildId },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'remove',
        'discord',
        '111111111111111111',
        '--yes',
      ]),
      { type: 'config-discord-guild-remove', connectionId, guildId, yes: true },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'discord', 'guild', 'list', 'discord', '--json']),
      { type: 'config-discord-guild-list', connectionId, json: true },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'set-invocation',
        'discord',
        '111111111111111111',
        'all-messages',
      ]),
      {
        type: 'config-discord-guild-set-invocation',
        connectionId,
        guildId,
        mode: 'all-messages',
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'set-users',
        'discord',
        '111111111111111111',
        'allow=123456789012345678,234567890123456789',
      ]),
      {
        type: 'config-discord-guild-set-users',
        connectionId,
        guildId,
        policy: { mode: 'allow', ids: ['123456789012345678', '234567890123456789'] },
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'set-channels',
        'discord',
        '111111111111111111',
        'allow=123456789012345678,234567890123456789',
      ]),
      {
        type: 'config-discord-guild-set-channels',
        connectionId,
        guildId,
        policy: { mode: 'allow', ids: ['123456789012345678', '234567890123456789'] },
      },
    )
  }),
)

it.effect('parses guild-scoped channel configuration updates', () =>
  Effect.gen(function* () {
    const connectionId = decodeConnectionId('discord')
    const guildId = decodeGuildId('111111111111111111')
    const channelId = decodeChannelId('222222222222222222')
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--invocation',
        'mention-only',
        '--users',
        'deny=123456789012345678',
        '--reply-in-channel',
      ]),
      {
        type: 'config-discord-guild-channel-set',
        connectionId,
        guildId,
        channelId,
        patch: {
          invocationMode: 'mention-only',
          users: { mode: 'deny', ids: ['123456789012345678'] },
          replyMode: 'reply-in-channel',
        },
      },
    )
    // A partial patch carries only the given overrides.
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--reply-in-thread',
      ]),
      {
        type: 'config-discord-guild-channel-set',
        connectionId,
        guildId,
        channelId,
        patch: { replyMode: 'reply-in-thread' },
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--invocation',
        'all-messages',
      ]),
      {
        type: 'config-discord-guild-channel-set',
        connectionId,
        guildId,
        channelId,
        patch: { invocationMode: 'all-messages' },
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--users',
        'all',
      ]),
      {
        type: 'config-discord-guild-channel-set',
        connectionId,
        guildId,
        channelId,
        patch: { users: { mode: 'all', ids: [] } },
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'channel',
        'reset',
        'discord',
        '111111111111111111',
        '222222222222222222',
      ]),
      {
        type: 'config-discord-guild-channel-reset',
        connectionId,
        guildId,
        channelId,
      },
    )
  }),
)

it.effect('rejects malformed guild configuration commands', () =>
  Effect.gen(function* () {
    const invalid: ReadonlyArray<ReadonlyArray<string>> = [
      ['config', 'discord'],
      ['config', 'discord', 'wat'],
      ['config', 'discord', 'connection'],
      ['config', 'discord', 'connection', 'list', '--json', '--json'],
      ['config', 'discord', 'connection', 'list', 'extra'],
      ['config', 'discord', 'guild', 'enable', 'discord'], // missing guild id
      ['config', 'discord', 'guild', 'enable', 'discord', '111111111111111111', 'extra'],
      ['config', 'discord', 'guild', 'enable', 'discord', 'not-a-snowflake'],
      ['config', 'discord', 'guild', 'enable', '--flag', '111111111111111111'], // flag-like connection
      ['config', 'discord', 'guild', 'dance', 'discord', '111111111111111111'],
      ['config', 'discord', 'guild', 'list'], // missing connection
      ['config', 'discord', 'guild', 'list', 'discord', '--json', 'extra'],
      ['config', 'discord', 'guild', 'list', '--json'], // flag-like connection
      ['config', 'discord', 'guild', 'invocation', 'set', 'discord', '111111111111111111'],
      ['config', 'discord', 'guild', 'invocation', 'set', 'discord', '111111111111111111', 'loud'],
      // A wrong subcommand at full length must be rejected, not parsed as set.
      [
        'config',
        'discord',
        'guild',
        'invocation',
        'get',
        'discord',
        '111111111111111111',
        'all-messages',
      ],
      ['config', 'discord', 'guild', 'users', 'get', 'discord', '111111111111111111', 'all'],
      ['config', 'discord', 'guild', 'users', 'set', 'discord', '111111111111111111', 'allow='],
      ['config', 'discord', 'guild', 'users', 'set', 'discord', '111111111111111111', 'sometimes'],
      ['config', 'discord', 'guild', 'users', 'set', 'discord', '111111111111111111', 'allow=abc'],
      ['config', 'discord', 'guild', 'users', 'set', 'discord', '111111111111111111'],
      // A channel set without any override would be a no-op row.
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
      ],
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--users',
      ], // missing users value
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--invocation',
        '--reply-in-channel',
      ], // flag consumed as value
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--reply-in-channel',
        '--reply-in-thread',
      ], // duplicate reply mode
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--users',
        'all',
        '--users',
        'deny=123456789012345678',
      ], // duplicate users
      [
        'config',
        'discord',
        'guild',
        'channel',
        'reset',
        'discord',
        '111111111111111111',
        'not-a-snowflake',
      ],
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        'not-a-snowflake',
        '--reply-in-channel',
      ],
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--invocation',
        'all-messages',
        '--invocation',
        'mention-only',
      ], // duplicate invocation
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--shout',
      ], // unknown flag
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '--invocation',
        'all-messages',
      ], // flag-like channel id
      ['config', 'discord', 'guild', 'channel', 'reset', 'discord', '111111111111111111'],
      ['config', 'discord', 'guild', 'channel', 'dance', 'discord', '111111111111111111'],
    ]
    for (const arguments_ of invalid) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected typed failure: ${arguments_.join(' ')}`)
    }
  }),
)

it.effect('parses permission policy specifications', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseAccessPolicySpec('all'), { mode: 'all', ids: [] })
    assert.deepStrictEqual(yield* parseAccessPolicySpec('allow=123456789012345678'), {
      mode: 'allow',
      ids: ['123456789012345678'],
    })
    // Snowflake ids tolerate surrounding whitespace but must be valid snowflakes.
    assert.deepStrictEqual(
      yield* parseAccessPolicySpec('deny= 123456789012345678 , 234567890123456789 '),
      {
        mode: 'deny',
        ids: ['123456789012345678', '234567890123456789'],
      },
    )
    const emptyIds = yield* parseAccessPolicySpec('allow=').pipe(Effect.flip)
    assert(isFridayCliError(emptyIds))
    assert.strictEqual(emptyIds.argument, 'allow=')
    const trailingComma = yield* parseAccessPolicySpec('allow=123456789012345678,').pipe(
      Effect.flip,
    )
    assert(isFridayCliError(trailingComma))
    const badPrefix = yield* parseAccessPolicySpec('ALLOW=123456789012345678').pipe(Effect.flip)
    assert(isFridayCliError(badPrefix))
    const noEquals = yield* parseAccessPolicySpec('deny').pipe(Effect.flip)
    assert(isFridayCliError(noEquals))
    // The mode must sit at the start of the spec and the ids at the end.
    const prefixed = yield* parseAccessPolicySpec('xallow=123456789012345678').pipe(Effect.flip)
    assert(isFridayCliError(prefixed))
    const suffixed = yield* parseAccessPolicySpec('allow=123456789012345678\nextra').pipe(
      Effect.flip,
    )
    assert(isFridayCliError(suffixed))
  }),
)

it.effect('parses Discord activity-description updates and rejects the removed platform form', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'discord', 'activity-description', 'set', 'discord']),
      {
        type: 'config-discord-activity-description-set',
        connectionId: decodeConnectionId('discord'),
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'discord', 'activity-description', 'reset', 'discord']),
      {
        type: 'config-discord-activity-description-reset',
        connectionId: decodeConnectionId('discord'),
      },
    )
    for (const removed of [
      ['platform', 'activity-description', 'set', 'discord'],
      ['platform', 'activity-description', 'reset', 'discord'],
      ['config', 'discord', 'activity-description', 'set'],
      ['config', 'discord', 'activity-description', 'toggle', 'discord'],
    ]) {
      const error = yield* parseFridayCli(removed).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${removed.join(' ')}`)
    }
    const removedError = yield* parseFridayCli([
      'platform',
      'activity-description',
      'set',
      'discord',
    ]).pipe(Effect.flip)
    assert.match(removedError.message, /was removed/)
    assert.match(removedError.message, /config discord activity-description/)
  }),
)

it.effect('parses partial Discord connection updates', () =>
  Effect.gen(function* () {
    const connectionId = decodeConnectionId('discord-main')
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--name',
        'Renamed bot',
      ]),
      { type: 'config-discord-connection-update', connectionId, name: 'Renamed bot' },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--no-respond-to-global-mentions',
      ]),
      { type: 'config-discord-connection-update', connectionId, respondToGlobalMentions: false },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--application-id',
        '111111111111111111',
        '--public-key',
        '0123456789abcdef'.repeat(4),
        '--bot-token-env',
        'FRIDAY_DISCORD_TOKEN_NEW',
        '--respond-to-global-mentions',
      ]),
      {
        type: 'config-discord-connection-update',
        connectionId,
        applicationId: decodeGuildId('111111111111111111'),
        publicKey: decodePublicKey('0123456789abcdef'.repeat(4)),
        botTokenEnv: decodeBotTokenEnv('FRIDAY_DISCORD_TOKEN_NEW'),
        respondToGlobalMentions: true,
      },
    )
  }),
)

it.effect('rejects connection updates without fields, with duplicates, or with bad values', () =>
  Effect.gen(function* () {
    const invalid: ReadonlyArray<ReadonlyArray<string>> = [
      ['config', 'discord', 'connection', 'update'], // missing connection id
      ['config', 'discord', 'connection', 'update', 'discord-main'], // no fields
      ['config', 'discord', 'connection', 'update', 'discord-main', '--name', 'A', '--name', 'B'], // duplicate name
      [
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--respond-to-global-mentions',
        '--no-respond-to-global-mentions',
      ], // contradicting boolean flags
      [
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--application-id',
        'not-a-snowflake',
      ],
      ['config', 'discord', 'connection', 'update', 'discord-main', '--shout', 'x'], // unknown flag
      [
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--bot-token-env',
        'not an env name',
      ],
      ['config', 'discord', 'connection', 'update', 'discord-main', '--name'], // missing value
    ]
    for (const arguments_ of invalid) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${arguments_.join(' ')}`)
    }
    const noFields = yield* parseFridayCli([
      'config',
      'discord',
      'connection',
      'update',
      'discord-main',
    ]).pipe(Effect.flip)
    assert.match(noFields.message, /at least one field/)
    assert.match(noFields.message, /--respond-to-global-mentions/)
  }),
)

it.effect('rejects guild removal without --yes and the removed guild command forms', () =>
  Effect.gen(function* () {
    const refused = yield* parseFridayCli([
      'config',
      'discord',
      'guild',
      'remove',
      'discord',
      '111111111111111111',
    ]).pipe(Effect.flip)
    assert(isFridayCliError(refused))
    assert.match(refused.message, /--yes/)
    assert.match(refused.message, /channel overrides/)

    for (const removed of [
      [
        'config',
        'discord',
        'guild',
        'invocation',
        'set',
        'discord',
        '111111111111111111',
        'all-messages',
      ],
      ['config', 'discord', 'guild', 'users', 'set', 'discord', '111111111111111111', 'all'],
    ]) {
      const error = yield* parseFridayCli(removed).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${removed.join(' ')}`)
      assert.match(error.message, /was removed/)
      assert.match(error.message, /set-(invocation|users)/)
    }
  }),
)

it.effect('parses worktree and workspace cleanup listings', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['worktree', 'list']), {
      type: 'worktree-list',
      json: false,
    })
    assert.deepStrictEqual(yield* parseFridayCli(['worktree', 'list', '--json']), {
      type: 'worktree-list',
      json: true,
    })
    assert.deepStrictEqual(yield* parseFridayCli(['workspace', 'cleanup', 'list']), {
      type: 'workspace-cleanup-list',
      json: false,
    })
    assert.deepStrictEqual(yield* parseFridayCli(['workspace', 'cleanup', 'list', '--json']), {
      type: 'workspace-cleanup-list',
      json: true,
    })
    for (const invalid of [
      ['worktree', 'list', 'extra'],
      ['worktree', 'list', '--json', '--json'],
      ['worktree', 'dance'],
      ['workspace', 'cleanup', 'list', 'extra'],
      ['workspace', 'cleanup', 'dance'],
    ]) {
      const error = yield* parseFridayCli(invalid).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${invalid.join(' ')}`)
    }
  }),
)

it.effect('resolves --help at any depth to the matching command topic', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['--help']), { type: 'help', topic: [] })
    assert.deepStrictEqual(yield* parseFridayCli(['-h']), { type: 'help', topic: [] })
    assert.deepStrictEqual(yield* parseFridayCli(['config', '--help']), {
      type: 'help',
      topic: ['config'],
    })
    assert.deepStrictEqual(yield* parseFridayCli(['config', 'discord', 'guild', '--help']), {
      type: 'help',
      topic: ['config', 'discord', 'guild'],
    })
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'discord',
        'guild',
        'set-invocation',
        'discord',
        '111111111111111111',
        'all-messages',
        '--help',
      ]),
      { type: 'help', topic: ['config', 'discord', 'guild', 'set-invocation'] },
    )
    // An unknown prefix falls back to the nearest known parent topic.
    assert.deepStrictEqual(yield* parseFridayCli(['config', 'discord', 'wat', '--help']), {
      type: 'help',
      topic: ['config', 'discord'],
    })
  }),
)

it.effect('reports unknown subcommands with the known sibling list at every depth', () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<{
      readonly arguments_: ReadonlyArray<string>
      readonly prefix: string
      readonly head: string
      readonly known: string
    }> = [
      {
        arguments_: ['wat'],
        prefix: 'friday',
        head: 'wat',
        known: 'start, config, model, worktree, workspace',
      },
      {
        arguments_: ['config', 'wat'],
        prefix: 'friday config',
        head: 'wat',
        known: 'reload, model, profile, admin, discord',
      },
      {
        arguments_: ['config', 'admin', 'wat'],
        prefix: 'friday config admin',
        head: 'wat',
        known: 'discord',
      },
      {
        arguments_: ['config', 'admin', 'discord', 'wat'],
        prefix: 'friday config admin discord',
        head: 'wat',
        known: 'add, remove, list',
      },
      {
        arguments_: ['config', 'discord', 'wat'],
        prefix: 'friday config discord',
        head: 'wat',
        known: 'connection, guild, activity-description',
      },
      {
        arguments_: ['config', 'discord', 'connection', 'wat'],
        prefix: 'friday config discord connection',
        head: 'wat',
        known: 'add, update, remove, enable, disable, get, list',
      },
      {
        arguments_: ['config', 'discord', 'guild', 'wat'],
        prefix: 'friday config discord guild',
        head: 'wat',
        known: 'enable, disable, remove, list, set-invocation, set-users, set-channels, channel',
      },
      {
        arguments_: ['config', 'discord', 'guild', 'channel', 'wat'],
        prefix: 'friday config discord guild channel',
        head: 'wat',
        known: 'set, reset',
      },
      {
        arguments_: ['worktree', 'dance'],
        prefix: 'friday worktree',
        head: 'dance',
        known: 'ensure, list',
      },
      {
        arguments_: ['workspace', 'dance'],
        prefix: 'friday workspace',
        head: 'dance',
        known: 'cleanup',
      },
      {
        arguments_: ['workspace', 'cleanup', 'dance'],
        prefix: 'friday workspace cleanup',
        head: 'dance',
        known: 'apply, list',
      },
    ]
    for (const { arguments_, prefix, head, known } of cases) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert.strictEqual(
        error.message,
        `Unknown '${prefix}' subcommand '${head}'. Known subcommands: ${known}.`,
        `unexpected rejection for: ${arguments_.join(' ')}`,
      )
    }
  }),
)

it.effect('asks for a subcommand when a command prefix stops at a branch', () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<{
      readonly arguments_: ReadonlyArray<string>
      readonly prefix: string
      readonly known: string
    }> = [
      {
        arguments_: ['config'],
        prefix: 'friday config',
        known: 'reload, model, profile, admin, discord',
      },
      {
        arguments_: ['config', 'admin'],
        prefix: 'friday config admin',
        known: 'discord',
      },
      {
        arguments_: ['config', 'admin', 'discord'],
        prefix: 'friday config admin discord',
        known: 'add, remove, list',
      },
      {
        arguments_: ['config', 'discord'],
        prefix: 'friday config discord',
        known: 'connection, guild, activity-description',
      },
      {
        arguments_: ['config', 'discord', 'connection'],
        prefix: 'friday config discord connection',
        known: 'add, update, remove, enable, disable, get, list',
      },
      {
        arguments_: ['config', 'discord', 'guild'],
        prefix: 'friday config discord guild',
        known: 'enable, disable, remove, list, set-invocation, set-users, set-channels, channel',
      },
      {
        arguments_: ['config', 'discord', 'guild', 'channel'],
        prefix: 'friday config discord guild channel',
        known: 'set, reset',
      },
      {
        arguments_: ['worktree'],
        prefix: 'friday worktree',
        known: 'ensure, list',
      },
      {
        arguments_: ['workspace'],
        prefix: 'friday workspace',
        known: 'cleanup',
      },
      {
        arguments_: ['workspace', 'cleanup'],
        prefix: 'friday workspace cleanup',
        known: 'apply, list',
      },
    ]
    for (const { arguments_, prefix, known } of cases) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert.strictEqual(
        error.message,
        `Provide a subcommand of '${prefix}'. Known subcommands: ${known}.`,
        `unexpected rejection for: ${arguments_.join(' ')}`,
      )
    }
  }),
)

it.effect('renders help that covers every branch and leaf of the command tree', () =>
  Effect.sync(() => {
    const help = renderCliHelp([])
    const leafPaths: Array<string> = []
    const branchPaths: Array<ReadonlyArray<string>> = []
    const walk = (node: CliCommandSpec, path: ReadonlyArray<string>): void => {
      if (isCliRemoved(node)) return
      const nextPath = [...path, node.name]
      if (isCliBranch(node)) {
        branchPaths.push(nextPath)
        node.children.forEach((child) => walk(child, nextPath))
        return
      }
      // Leaf entries render the name path plus the first usage fragment.
      leafPaths.push(
        `${nextPath.join(' ')}${node.arguments?.[0] === undefined ? '' : ` ${node.arguments[0]}`}`,
      )
    }
    cliCommandSpec.children.forEach((child) => walk(child, []))
    // Every live leaf appears exactly once in the full listing.
    for (const leafPath of leafPaths) {
      assert.strictEqual(
        help.split(`  ${leafPath}`).length - 1,
        1,
        `expected exactly one '${leafPath}' entry in help`,
      )
    }
    // Every branch topic's own help names all of its live children.
    for (const branchPath of branchPaths) {
      const branchHelp = renderCliHelp(branchPath)
      const node = findCommandSpec(branchPath)
      assert(node !== undefined && isCliBranch(node))
      for (const child of node.children) {
        if (isCliRemoved(child)) continue
        assert(
          branchHelp.includes(`  ${child.name}`),
          `expected '${child.name}' in help for '${branchPath.join(' ')}'`,
        )
      }
    }
  }),
)

it.effect('names known subcommands and removals in validation errors', () =>
  Effect.gen(function* () {
    const unknownGuild = yield* parseFridayCli([
      'config',
      'discord',
      'guild',
      'frobnicate',
      'discord',
      '111111111111111111',
    ]).pipe(Effect.flip)
    assert.match(
      unknownGuild.message,
      /Unknown 'friday config discord guild' subcommand 'frobnicate'/,
    )
    assert.match(unknownGuild.message, /set-invocation, set-users, set-channels/)

    const unknownTop = yield* parseFridayCli(['wat']).pipe(Effect.flip)
    assert.match(unknownTop.message, /Unknown 'friday' subcommand 'wat'/)
    assert.match(unknownTop.message, /Known subcommands: start, config, model, worktree, workspace/)
  }),
)

it.effect('parses an approved workspace cleanup proposal', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* parseFridayCli(['workspace', 'cleanup', 'apply', 'cleanup-123', '--json']),
      {
        type: 'workspace-cleanup-apply',
        proposalId: decodeCleanupProposalId('cleanup-123'),
        json: true,
      },
    )
  }),
)

it.effect('parses model configuration and Pi catalog commands', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['config', 'model', 'get', 'primary', '--json']), {
      type: 'config-model-get',
      name: 'primary',
      json: true,
    })
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'config',
        'model',
        'set',
        'utility',
        '--provider',
        'test-provider',
        '--model-id',
        'test-model',
        '--thinking',
        'high',
      ]),
      {
        type: 'config-model-set',
        selection: {
          name: 'utility',
          provider: decodeProviderId('test-provider'),
          modelId: decodeModelId('test-model'),
          thinkingLevel: 'high',
        },
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'profile', 'update', 'primary', '--thinking', 'max']),
      {
        type: 'config-profile-update',
        patch: { name: decodeProfileName('primary'), thinkingLevel: 'max' },
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['model', 'list', '--provider', 'openai', '--available', '--json']),
      { type: 'model-list', provider: 'openai', available: true, json: true },
    )
    assert.deepStrictEqual(yield* parseFridayCli(['model', 'get', 'openai', 'gpt-test']), {
      type: 'model-get',
      provider: 'openai',
      modelId: 'gpt-test',
      json: false,
    })
    assert.deepStrictEqual(yield* parseFridayCli(['model', 'reload']), { type: 'model-reload' })
    assert.match(renderCliHelp(['config', 'model']), /set <primary\|utility>/)
    assert.match(renderCliHelp(['model']), /reload/)
  }),
)

it.effect('prints JSON null for missing profile and catalog model lookups', () =>
  Effect.gen(function* () {
    yield* runFridayCli(['config', 'profile', 'get', 'missing', '--json'], {
      ...strictRunnerStubs,
      getSubagentProfile: () => Effect.succeed(Option.none()),
    })
    assert.strictEqual(yield* decodeJsonNull(yield* lastLine), null)

    yield* runFridayCli(['model', 'get', 'provider', 'missing', '--json'], {
      ...strictRunnerStubs,
      getPiModel: () => Effect.succeed(undefined),
    })
    assert.strictEqual(yield* decodeJsonNull(yield* lastLine), null)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('requests reload only for committed model and profile mutations', () =>
  Effect.gen(function* () {
    const modelArguments = [
      'config',
      'model',
      'set',
      'primary',
      '--provider',
      'provider',
      '--model-id',
      'model',
      '--thinking',
      'medium',
    ]
    const profileArguments = [
      'config',
      'profile',
      'add',
      'worker',
      '--description',
      'Worker profile',
      '--provider',
      'provider',
      '--model-id',
      'model',
      '--thinking',
      'medium',
    ]
    const cases = [
      {
        arguments_: modelArguments,
        operation: 'setConfiguredModel' as const,
        outcomes: ['unchanged', 'updated'] as const,
      },
      {
        arguments_: profileArguments,
        operation: 'addSubagentProfile' as const,
        outcomes: ['exists', 'added'] as const,
      },
      {
        arguments_: ['config', 'profile', 'update', 'worker', '--thinking', 'high'],
        operation: 'updateSubagentProfile' as const,
        outcomes: ['unchanged', 'updated'] as const,
      },
      {
        arguments_: ['config', 'profile', 'remove', 'worker', '--yes'],
        operation: 'removeSubagentProfile' as const,
        outcomes: ['missing', 'removed'] as const,
      },
    ]
    for (const testCase of cases) {
      for (const [index, outcome] of testCase.outcomes.entries()) {
        let reloads = 0
        yield* runFridayCli(testCase.arguments_, {
          ...strictRunnerStubs,
          [testCase.operation]: () => Effect.succeed(outcome),
          reloadConfig: Effect.sync(() => {
            reloads += 1
            return reloadSucceeded(2)
          }),
        })
        assert.strictEqual(reloads, index, `${testCase.operation} ${outcome}`)
      }
    }
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('keeps the committed write when the running process rejects reload', () =>
  Effect.gen(function* () {
    let storedModelId = 'before'
    const error = yield* runFridayCli(
      [
        'config',
        'model',
        'set',
        'primary',
        '--provider',
        'provider',
        '--model-id',
        'after',
        '--thinking',
        'medium',
      ],
      {
        ...strictRunnerStubs,
        setConfiguredModel: (selection) =>
          Effect.sync(() => {
            storedModelId = selection.modelId
            return 'updated' as const
          }),
        reloadConfig: Effect.succeed(reloadFailed('invalid stored configuration')),
      },
    ).pipe(Effect.flip)
    assert(isConfigReloadRejectedError(error))
    assert.strictEqual(storedModelId, 'after')
    assert.match(yield* lastLine, /Friday primary model updated/)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('classifies only absence errnos as a stopped process after a committed write', () =>
  Effect.gen(function* () {
    const arguments_ = [
      'config',
      'model',
      'set',
      'primary',
      '--provider',
      'provider',
      '--model-id',
      'model',
      '--thinking',
      'medium',
    ]
    for (const errno of ['ENOENT', 'ECONNREFUSED']) {
      yield* runFridayCli(arguments_, {
        ...strictRunnerStubs,
        setConfiguredModel: () => Effect.succeed('updated' as const),
        reloadConfig: Effect.fail(
          new ControlSocketError({
            operation: 'connect',
            path: '/tmp/missing',
            detail: 'connect failed',
            errno,
          }),
        ),
      })
      assert.match(yield* lastLine, /next start will load the stored change/)
    }

    const permissionError = new ControlSocketError({
      operation: 'connect',
      path: '/tmp/forbidden',
      detail: 'connect failed',
      errno: 'EACCES',
    })
    const failure = yield* runFridayCli(arguments_, {
      ...strictRunnerStubs,
      setConfiguredModel: () => Effect.succeed('updated' as const),
      reloadConfig: Effect.fail(permissionError),
    }).pipe(Effect.flip)
    assert.strictEqual(failure, permissionError)
    assert.match(yield* lastLine, /Friday primary model updated/)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('parses the config reload command', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['config', 'reload']), {
      type: 'config-reload',
    })
    const forced = yield* parseFridayCli(['config', 'reload', '--force']).pipe(Effect.flip)
    assert(isFridayCliError(forced))
    assert.strictEqual(forced.argument, 'config reload --force')
  }),
)

it.effect('parses Discord administrator allow-list commands', () =>
  Effect.gen(function* () {
    const userId = decodeDiscordUserId('123456789012345678')
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'admin', 'discord', 'add', '123456789012345678']),
      { type: 'config-admin-discord-add', userId },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'admin', 'discord', 'remove', '123456789012345678']),
      { type: 'config-admin-discord-remove', userId },
    )
    assert.deepStrictEqual(yield* parseFridayCli(['config', 'admin', 'discord', 'list']), {
      type: 'config-admin-discord-list',
      json: false,
    })
    assert.deepStrictEqual(
      yield* parseFridayCli(['config', 'admin', 'discord', 'list', '--json']),
      { type: 'config-admin-discord-list', json: true },
    )
  }),
)

it.effect('rejects invalid Discord user IDs and malformed admin commands', () =>
  Effect.gen(function* () {
    const invalid = [
      ['config', 'admin', 'discord', 'add', '1234567890123456'], // 16 digits: below boundary
      ['config', 'admin', 'discord', 'add', '123456789012345678901'], // 21 digits: above boundary
      ['config', 'admin', 'discord', 'add', '01234567890123456'], // leading zero
      ['config', 'admin', 'discord', 'add', 'not-a-snowflake'],
      ['config', 'admin', 'discord', 'add'], // missing argument
      ['config', 'admin', 'discord', 'add', '123456789012345678', 'extra'],
      ['config', 'admin', 'discord'], // missing operation
      ['config', 'admin', 'discord', 'list', '--json', '--json'], // too many list flags
      ['config', 'admin', 'discord', 'list', '--yaml'],
      ['config', 'admin', 'discord', 'upsert', '123456789012345678'],
    ]
    for (const arguments_ of invalid) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${arguments_.join(' ')}`)
    }

    // Failure errors carry the full offending argument list.
    const malformed = yield* parseFridayCli(['config', 'admin', 'discord', 'add']).pipe(Effect.flip)
    assert(isFridayCliError(malformed))
    assert.strictEqual(malformed.argument, 'config admin discord add')

    const invalidId = yield* parseFridayCli([
      'config',
      'admin',
      'discord',
      'add',
      'not-a-snowflake',
    ]).pipe(Effect.flip)
    assert(isFridayCliError(invalidId))
    assert.strictEqual(invalidId.argument, 'config admin discord add not-a-snowflake')

    const badListFlag = yield* parseFridayCli([
      'config',
      'admin',
      'discord',
      'list',
      '--yaml',
    ]).pipe(Effect.flip)
    assert(isFridayCliError(badListFlag))
    assert.strictEqual(badListFlag.argument, 'config admin discord list --yaml')

    const unknownOperation = yield* parseFridayCli([
      'config',
      'admin',
      'discord',
      'upsert',
      '123456789012345678',
    ]).pipe(Effect.flip)
    assert(isFridayCliError(unknownOperation))
    assert.strictEqual(unknownOperation.argument, 'config admin discord upsert 123456789012345678')
  }),
)

it.effect('formats admin outcomes and states the restart requirement', () =>
  Effect.sync(() => {
    const userId = decodeDiscordUserId('123456789012345678')
    assert.match(formatDiscordAdminAdd(userId, 'added'), /added\. Restart Friday/)
    assert.match(formatDiscordAdminAdd(userId, 'exists'), /is already configured/)
    assert(!formatDiscordAdminAdd(userId, 'exists').includes('Restart'))
    assert.match(formatDiscordAdminRemove(userId, 'removed'), /removed\. Restart Friday/)
    assert.match(formatDiscordAdminRemove(userId, 'missing'), /is not configured/)
    assert(!formatDiscordAdminRemove(userId, 'missing').includes('Restart'))
    assert.strictEqual(renderDiscordAdminList([]), 'No Discord administrators are configured.')
    assert.strictEqual(
      renderDiscordAdminList(['123456789012345678', '234567890123456789']),
      'Discord administrators:\n  123456789012345678\n  234567890123456789',
    )
  }),
)

it.effect('dispatches admin allow-list commands to exactly one operation each', () =>
  Effect.gen(function* () {
    const add = recorder('added' as const)
    yield* runFridayCli(['config', 'admin', 'discord', 'add', '123456789012345678'], {
      ...strictRunnerStubs,
      addDiscordAdmin: add.operation,
    })
    assert.deepStrictEqual(add.calls, [[decodeDiscordUserId('123456789012345678')]])

    const remove = recorder('removed' as const)
    yield* runFridayCli(['config', 'admin', 'discord', 'remove', '123456789012345678'], {
      ...strictRunnerStubs,
      removeDiscordAdmin: remove.operation,
    })
    assert.deepStrictEqual(remove.calls, [[decodeDiscordUserId('123456789012345678')]])

    const list = recorder(['123456789012345678'])
    yield* runFridayCli(['config', 'admin', 'discord', 'list', '--json'], {
      ...strictRunnerStubs,
      listDiscordAdmins: list.operation,
    })
    assert.deepStrictEqual(list.calls, [[]])
    const lines = yield* TestConsole.logLines
    assert.strictEqual(lines[lines.length - 1], '["123456789012345678"]')
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('runs the reload operation and reports rejections as typed errors', () =>
  Effect.gen(function* () {
    yield* runFridayCli(['config', 'reload'], {
      ...strictRunnerStubs,
      reloadConfig: Effect.succeed(reloadSucceeded(6)),
    })

    const rejected = yield* runFridayCli(['config', 'reload'], {
      ...strictRunnerStubs,
      reloadConfig: Effect.succeed(reloadFailed('Stored Friday configuration is invalid.')),
    }).pipe(Effect.flip)
    assert(isConfigReloadRejectedError(rejected))
    assert.match(rejected.message, /Stored Friday configuration is invalid\./)

    const transportError = yield* runFridayCli(['config', 'reload'], {
      ...strictRunnerStubs,
      reloadConfig: Effect.fail(
        new ControlSocketError({
          operation: 'connect',
          path: '/tmp/friday.sock',
          detail: 'Could not connect to the running Friday control socket.',
        }),
      ),
    }).pipe(Effect.flip)
    assert(isControlSocketError(transportError))
    assert.strictEqual(transportError.operation, 'connect')
  }),
)

it.effect('formats guild outcomes and states the reload requirement', () =>
  Effect.sync(() => {
    const guildId = decodeGuildId('111111111111111111')
    const channelId = decodeChannelId('222222222222222222')
    const note = 'The running Friday picks this up on its next configuration reload.'
    assert.strictEqual(
      formatDiscordGuildEnable(guildId, 'enabled'),
      `Guild 111111111111111111 enabled. ${note}`,
    )
    assert.strictEqual(
      formatDiscordGuildEnable(guildId, 'already-enabled'),
      'Guild 111111111111111111 is already enabled.',
    )
    assert.strictEqual(
      formatDiscordGuildDisable(guildId, 'disabled'),
      `Guild 111111111111111111 disabled. ${note}`,
    )
    assert.strictEqual(
      formatDiscordGuildDisable(guildId, 'already-disabled'),
      'Guild 111111111111111111 is already disabled.',
    )
    assert.strictEqual(
      formatDiscordGuildDisable(guildId, 'missing'),
      'Guild 111111111111111111 is not configured.',
    )
    assert.strictEqual(
      formatDiscordGuildRemove(guildId, 'removed'),
      `Guild 111111111111111111 removed together with its channel overrides. ${note}`,
    )
    assert.strictEqual(
      formatDiscordGuildRemove(guildId, 'missing'),
      'Guild 111111111111111111 is not configured.',
    )
    assert.strictEqual(
      formatDiscordGuildInvocation(guildId, decodeMode('all-messages'), 'updated'),
      `Guild-wide invocation default for 111111111111111111 set to all-messages. ${note}`,
    )
    assert.strictEqual(
      formatDiscordGuildInvocation(guildId, decodeMode('mention-only'), 'missing'),
      'Guild 111111111111111111 is not configured. Enable it first.',
    )
    assert.strictEqual(
      formatDiscordGuildUsers(guildId, { mode: 'allow', ids: ['333333333333333333'] }, 'updated'),
      `Guild-wide user permission default for 111111111111111111 set to allow=333333333333333333. ${note}`,
    )
    assert.strictEqual(
      formatDiscordGuildUsers(guildId, { mode: 'all', ids: [] }, 'missing'),
      'Guild 111111111111111111 is not configured. Enable it first.',
    )
    assert.strictEqual(
      formatDiscordGuildChannels(guildId, { mode: 'deny', ids: ['444444444444444444'] }, 'updated'),
      `Guild channel scope for 111111111111111111 set to deny=444444444444444444. ${note}`,
    )
    assert.strictEqual(
      formatDiscordGuildChannels(guildId, { mode: 'all', ids: [] }, 'missing'),
      'Guild 111111111111111111 is not configured. Enable it first.',
    )
    assert.strictEqual(
      formatDiscordGuildChannelSet(channelId, 'updated'),
      `Channel 222222222222222222 overrides updated. ${note}`,
    )
    assert.strictEqual(
      formatDiscordGuildChannelSet(channelId, 'missing-guild'),
      'The guild owning channel 222222222222222222 is not configured. Enable it first.',
    )
    assert.strictEqual(
      formatDiscordGuildChannelReset(channelId, 'removed'),
      `Channel 222222222222222222 overrides removed; guild defaults apply. ${note}`,
    )
    assert.strictEqual(
      formatDiscordGuildChannelReset(channelId, 'missing'),
      'No overrides are configured for channel 222222222222222222.',
    )
  }),
)

it.effect('formats Discord connection lifecycle outcomes with exact restart guidance', () =>
  Effect.sync(() => {
    const connectionId = decodeConnectionId('discord-main')
    const restart = 'Restart Friday to apply it: connection topology is pinned at startup.'
    assert.strictEqual(
      formatDiscordConnectionAdd(connectionId, 'added'),
      `Discord connection discord-main added. ${restart}`,
    )
    assert.strictEqual(
      formatDiscordConnectionAdd(connectionId, 'connection-exists'),
      'A connection named discord-main already exists.',
    )
    assert.strictEqual(
      formatDiscordConnectionAdd(connectionId, 'application-exists'),
      'The application ID is already used by another Discord connection.',
    )
    assert.strictEqual(
      formatDiscordConnectionRemove(connectionId, 'removed'),
      `Discord connection discord-main removed together with its Discord configuration. ${restart}`,
    )
    assert.strictEqual(
      formatDiscordConnectionEnable(connectionId, 'already-enabled'),
      'Discord connection discord-main is already enabled.',
    )
    assert.strictEqual(
      formatDiscordConnectionDisable(connectionId, 'disabled'),
      `Discord connection discord-main disabled. ${restart}`,
    )
    assert.strictEqual(
      renderDiscordConnectionDetail({
        connectionId: 'discord-main',
        name: 'Main bot',
        enabled: true,
        applicationId: '111111111111111111',
        publicKey: '0123456789abcdef'.repeat(4),
        botTokenEnv: 'FRIDAY_DISCORD_TOKEN',
        respondToGlobalMentions: true,
        activityDescription: false,
      }),
      [
        'Discord connection discord-main:',
        '  Name: Main bot',
        '  Enabled: yes',
        '  Application ID: 111111111111111111',
        `  Public key: ${'0123456789abcdef'.repeat(4)}`,
        '  Bot token env: FRIDAY_DISCORD_TOKEN',
        '  Responds to global mentions: yes',
        '  Public activity description: no',
      ].join('\n'),
    )
  }),
)

it.effect('renders connection and guild listings', () =>
  Effect.sync(() => {
    assert.strictEqual(renderDiscordConnectionList([]), 'No Discord connections are configured.')
    assert.strictEqual(
      renderDiscordConnectionList([
        { connectionId: 'discord', name: 'Discord', enabled: true },
        { connectionId: 'discord-2', name: 'Second', enabled: false },
      ]),
      'Discord connections:\n  discord  enabled  Discord\n  discord-2  disabled  Second',
    )
    assert.strictEqual(renderDiscordGuildList([]), 'No guilds are configured for this connection.')
    assert.strictEqual(
      renderDiscordGuildList([
        {
          guildId: '111111111111111111',
          enabled: false,
          invocation: { defaultMode: 'all-messages' },
          channels: [
            {
              channelId: '222222222222222222',
              invocationMode: 'mention-only',
              users: { mode: 'deny', ids: ['333333333333333333'] },
              replyMode: 'reply-in-channel',
            },
            { channelId: '444444444444444444' },
          ],
        },
        {
          guildId: '555555555555555555',
          enabled: true,
          invocation: { defaultMode: 'mention-only' },
          users: { mode: 'allow', ids: ['333333333333333333', '666666666666666666'] },
          channelScope: { mode: 'allow', ids: ['222222222222222222'] },
          channels: [],
        },
      ]),
      [
        'guild 111111111111111111: disabled, invocation: all-messages',
        '  channel 222222222222222222: invocation: mention-only, users: deny=333333333333333333, reply: reply-in-channel',
        '  channel 444444444444444444: (no overrides)',
        'guild 555555555555555555: enabled, invocation: mention-only, users: allow=333333333333333333,666666666666666666, channels: allow=222222222222222222',
      ].join('\n'),
    )
  }),
)

it.effect('dispatches connection lifecycle commands to exactly one operation each', () =>
  Effect.gen(function* () {
    // Destructive removal reaches the operation only with an explicit --yes,
    // and carries the decoded connection id.
    const remove = recorder('removed' as const)
    yield* runFridayCli(['config', 'discord', 'connection', 'remove', 'discord-main', '--yes'], {
      ...strictRunnerStubs,
      removeDiscordConnection: remove.operation,
    })
    assert.deepStrictEqual(remove.calls, [[decodeConnectionId('discord-main')]])
    assert.match(
      yield* lastLine,
      /discord-main removed together with its Discord configuration\. Restart Friday/,
    )

    // Without --yes the command is refused before any operation runs.
    const refused = yield* runFridayCli(
      ['config', 'discord', 'connection', 'remove', 'discord-main'],
      { ...strictRunnerStubs, removeDiscordConnection: remove.operation },
    ).pipe(Effect.flip)
    assert(isFridayCliError(refused))
    assert.strictEqual(remove.calls.length, 1)

    // Add dispatches the full decoded action exactly once.
    const add = recorder('added' as const)
    yield* runFridayCli(
      [
        'config',
        'discord',
        'connection',
        'add',
        'discord-main',
        '--name',
        'Main bot',
        '--application-id',
        '111111111111111111',
        '--public-key',
        '0123456789abcdef'.repeat(4),
        '--bot-token-env',
        'FRIDAY_DISCORD_TOKEN',
        '--respond-to-global-mentions',
      ],
      { ...strictRunnerStubs, addDiscordConnection: add.operation },
    )
    assert.deepStrictEqual(add.calls, [
      [
        {
          type: 'config-discord-connection-add',
          connectionId: decodeConnectionId('discord-main'),
          name: 'Main bot',
          applicationId: decodeGuildId('111111111111111111'),
          publicKey: decodePublicKey('0123456789abcdef'.repeat(4)),
          botTokenEnv: decodeBotTokenEnv('FRIDAY_DISCORD_TOKEN'),
          respondToGlobalMentions: true,
        },
      ],
    ])

    // Enable and disable each dispatch exactly once with the decoded id.
    const enable = recorder('enabled' as const)
    yield* runFridayCli(['config', 'discord', 'connection', 'enable', 'discord-main'], {
      ...strictRunnerStubs,
      enableDiscordConnection: enable.operation,
    })
    assert.deepStrictEqual(enable.calls, [[decodeConnectionId('discord-main')]])

    const disable = recorder('disabled' as const)
    yield* runFridayCli(['config', 'discord', 'connection', 'disable', 'discord-main'], {
      ...strictRunnerStubs,
      disableDiscordConnection: disable.operation,
    })
    assert.deepStrictEqual(disable.calls, [[decodeConnectionId('discord-main')]])
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('restart and reload guidance tracks whether anything changed', () =>
  Effect.gen(function* () {
    // Connection topology changes require a restart; idempotent outcomes do not.
    const added = recorder('enabled' as const)
    yield* runFridayCli(['config', 'discord', 'connection', 'enable', 'discord-main'], {
      ...strictRunnerStubs,
      enableDiscordConnection: added.operation,
    })
    assert.match(yield* lastLine, /Restart Friday/)

    const unchanged = recorder('already-enabled' as const)
    yield* runFridayCli(['config', 'discord', 'connection', 'enable', 'discord-main'], {
      ...strictRunnerStubs,
      enableDiscordConnection: unchanged.operation,
    })
    const lastUnchanged = yield* lastLine
    assert.match(lastUnchanged, /already enabled/)
    assert(!lastUnchanged.includes('Restart Friday'))

    // Guild configuration changes apply on the next reload instead.
    const enabled = recorder('enabled' as const)
    yield* runFridayCli(['config', 'discord', 'guild', 'enable', 'discord', '111111111111111111'], {
      ...strictRunnerStubs,
      enableDiscordGuild: enabled.operation,
    })
    const enabledLines = yield* lastLine
    assert.match(enabledLines, /next configuration reload/)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('dispatches guild commands to exactly one operation with decoded arguments', () =>
  Effect.gen(function* () {
    const connectionId = decodeConnectionId('discord')
    const guildId = decodeGuildId('111111111111111111')
    const channelId = decodeChannelId('222222222222222222')

    const enable = recorder('enabled' as const)
    yield* runFridayCli(['config', 'discord', 'guild', 'enable', 'discord', '111111111111111111'], {
      ...strictRunnerStubs,
      enableDiscordGuild: enable.operation,
    })
    assert.deepStrictEqual(enable.calls, [[connectionId, guildId]])

    const disable = recorder('missing' as const)
    yield* runFridayCli(
      ['config', 'discord', 'guild', 'disable', 'discord', '111111111111111111'],
      { ...strictRunnerStubs, disableDiscordGuild: disable.operation },
    )
    assert.deepStrictEqual(disable.calls, [[connectionId, guildId]])

    // Guild removal is destructive for its channel overrides; --yes is required
    // before the dispatch happens at all.
    const remove = recorder('removed' as const)
    yield* runFridayCli(
      ['config', 'discord', 'guild', 'remove', 'discord', '111111111111111111', '--yes'],
      { ...strictRunnerStubs, removeDiscordGuild: remove.operation },
    )
    assert.deepStrictEqual(remove.calls, [[connectionId, guildId]])

    const invocation = recorder('updated' as const)
    yield* runFridayCli(
      [
        'config',
        'discord',
        'guild',
        'set-invocation',
        'discord',
        '111111111111111111',
        'all-messages',
      ],
      { ...strictRunnerStubs, setDiscordGuildInvocation: invocation.operation },
    )
    assert.deepStrictEqual(invocation.calls, [[connectionId, guildId, decodeMode('all-messages')]])

    const users = recorder('updated' as const)
    yield* runFridayCli(
      [
        'config',
        'discord',
        'guild',
        'set-users',
        'discord',
        '111111111111111111',
        'allow=333333333333333333,234567890123456789',
      ],
      { ...strictRunnerStubs, setDiscordGuildUsers: users.operation },
    )
    assert.deepStrictEqual(users.calls, [
      [connectionId, guildId, { mode: 'allow', ids: ['333333333333333333', '234567890123456789'] }],
    ])

    const channels = recorder('updated' as const)
    yield* runFridayCli(
      [
        'config',
        'discord',
        'guild',
        'set-channels',
        'discord',
        '111111111111111111',
        'deny=444444444444444444',
      ],
      { ...strictRunnerStubs, setDiscordGuildChannels: channels.operation },
    )
    assert.deepStrictEqual(channels.calls, [
      [connectionId, guildId, { mode: 'deny', ids: ['444444444444444444'] }],
    ])

    // A partial channel patch carries only the override given on the command
    // line; the other fields must stay absent so they keep their current value.
    const setChannel = recorder('updated' as const)
    yield* runFridayCli(
      [
        'config',
        'discord',
        'guild',
        'channel',
        'set',
        'discord',
        '111111111111111111',
        '222222222222222222',
        '--reply-in-thread',
      ],
      { ...strictRunnerStubs, setDiscordGuildChannel: setChannel.operation },
    )
    assert.deepStrictEqual(setChannel.calls, [
      [connectionId, guildId, channelId, { replyMode: 'reply-in-thread' }],
    ])

    const resetChannel = recorder('removed' as const)
    yield* runFridayCli(
      [
        'config',
        'discord',
        'guild',
        'channel',
        'reset',
        'discord',
        '111111111111111111',
        '222222222222222222',
      ],
      { ...strictRunnerStubs, resetDiscordGuildChannel: resetChannel.operation },
    )
    assert.deepStrictEqual(resetChannel.calls, [[connectionId, guildId, channelId]])
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('dispatches help and version to the console', () =>
  Effect.gen(function* () {
    yield* runFridayCli(['--version'], strictRunnerStubs)
    assert.strictEqual(yield* lastLine, FRIDAY_VERSION)

    yield* runFridayCli(['--help'], strictRunnerStubs)
    const help = yield* lastLine
    assert.match(help, /Usage:/)
    assert.match(help, /Options:/)
    // The rendered listing covers the whole command tree, including renames.
    assert.match(help, /config discord connection update <connection-id>/)
    assert.match(help, /config discord guild set-invocation <connection-id>/)
    assert.match(help, /config discord guild set-users <connection-id>/)
    assert.match(help, /config discord activity-description set <connection-id>/)
    assert.match(help, /worktree list \[--json\]/)
    assert.match(help, /workspace cleanup list \[--json\]/)
    assert(!help.includes('platform activity-description'))
    assert(!help.includes('guild invocation set'))
    assert(!help.includes('guild users set'))

    // Depth help: branch topics list their children, leaf topics show usage.
    yield* runFridayCli(['config', 'discord', 'guild', '--help'], strictRunnerStubs)
    const guildHelp = yield* lastLine
    assert.match(guildHelp, /Commands:/)
    assert.match(guildHelp, /set-invocation <connection-id> <guild-id>/)
    assert(!guildHelp.includes('worktree'))

    yield* runFridayCli(['config', 'discord', 'guild', 'set-users', '--help'], strictRunnerStubs)
    const leafHelp = yield* lastLine
    assert.match(leafHelp, /Usage:/)
    assert.match(leafHelp, /friday config discord guild set-users <connection-id> <guild-id>/)
    assert(!leafHelp.includes('Commands:'))
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('dispatches connection updates and reports change-aware restart guidance', () =>
  Effect.gen(function* () {
    const update = recorder('updated' as const)
    yield* runFridayCli(
      ['config', 'discord', 'connection', 'update', 'discord-main', '--name', 'Renamed'],
      { ...strictRunnerStubs, updateDiscordConnection: update.operation },
    )
    assert.deepStrictEqual(update.calls, [
      [
        {
          type: 'config-discord-connection-update',
          connectionId: decodeConnectionId('discord-main'),
          name: 'Renamed',
        },
      ],
    ])
    assert.match(yield* lastLine, /discord-main updated\. Restart Friday/)

    const unchanged = recorder('unchanged' as const)
    yield* runFridayCli(
      ['config', 'discord', 'connection', 'update', 'discord-main', '--name', 'Same'],
      { ...strictRunnerStubs, updateDiscordConnection: unchanged.operation },
    )
    const unchangedLine = yield* lastLine
    assert.match(unchangedLine, /already has the requested configuration/)
    assert(!unchangedLine.includes('Restart Friday'))

    const missing = recorder('missing' as const)
    yield* runFridayCli(
      ['config', 'discord', 'connection', 'update', 'discord-main', '--name', 'Same'],
      { ...strictRunnerStubs, updateDiscordConnection: missing.operation },
    )
    assert.match(yield* lastLine, /is not configured\./)

    const duplicateApplication = recorder('application-exists' as const)
    yield* runFridayCli(
      [
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--application-id',
        '111111111111111111',
      ],
      { ...strictRunnerStubs, updateDiscordConnection: duplicateApplication.operation },
    )
    assert.match(yield* lastLine, /already used by another Discord connection/)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('dispatches worktree and cleanup listings with human and JSON output', () =>
  Effect.gen(function* () {
    const worktrees = [
      {
        url: 'git@github.com:one-terrace/timezone-relay-bot.git',
        commonDirectory: '/home/friday/.friday/repositories/cache.git',
        path: '/tmp/channel/timezone-relay-bot',
        branch: 'friday/channel/abc123',
        head: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        prunable: false,
      },
    ]
    const listWorktrees = recorder(worktrees)
    yield* runFridayCli(['worktree', 'list', '--json'], {
      ...strictRunnerStubs,
      listWorktrees: listWorktrees.operation,
    })
    assert.deepStrictEqual(listWorktrees.calls, [[]])
    assert.strictEqual(yield* lastLine, JSON.stringify(worktrees))

    const listWorktreesHuman = recorder(worktrees)
    yield* runFridayCli(['worktree', 'list'], {
      ...strictRunnerStubs,
      listWorktrees: listWorktreesHuman.operation,
    })
    assert.deepStrictEqual(listWorktreesHuman.calls, [[]])
    const worktreeLine = yield* lastLine
    assert.match(worktreeLine, /timezone-relay-bot/)
    assert.match(worktreeLine, /friday\/channel\/abc123/)
    // The human listing shortens the head to 12 hex digits.
    assert.match(worktreeLine, /a1b2c3d4e5f6/)
    assert(!worktreeLine.includes('a1b2c3d4e5f6a7b8'))

    const proposals = [
      {
        id: decodeCleanupProposalId('cleanup-1'),
        threadId: decodeThreadId('task-1'),
        status: 'pending' as const,
        workspacePath: '/tmp/channel',
        estimatedBytes: 4096,
        createdAt: '2025-01-01T00:00:00Z',
        appliedAt: null,
        summary: '1 repository worktree, 0 with uncommitted files, approximately 4096 bytes.',
        resources: [
          {
            path: '/tmp/channel/timezone-relay-bot',
            branch: 'friday/channel/abc123',
            head: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
            commonDirectory: '/home/friday/.friday/repositories/cache.git',
            status: '',
            sizeBytes: 4096,
            removalStatus: 'pending' as const,
          },
        ],
      },
    ]
    const listProposals = recorder(proposals)
    yield* runFridayCli(['workspace', 'cleanup', 'list', '--json'], {
      ...strictRunnerStubs,
      listWorkspaceCleanupProposals: listProposals.operation,
    })
    assert.deepStrictEqual(listProposals.calls, [[]])
    assert.strictEqual(yield* lastLine, JSON.stringify(proposals))

    const listProposalsHuman = recorder(proposals)
    yield* runFridayCli(['workspace', 'cleanup', 'list'], {
      ...strictRunnerStubs,
      listWorkspaceCleanupProposals: listProposalsHuman.operation,
    })
    assert.deepStrictEqual(listProposalsHuman.calls, [[]])
    const proposalLines = yield* lastLine
    assert.match(proposalLines, /cleanup-1  pending/)
    assert.match(proposalLines, /Worktree: \/tmp\/channel\/timezone-relay-bot/)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('renders empty worktree and cleanup listings', () =>
  Effect.sync(() => {
    assert.strictEqual(
      renderWorktreeList([]),
      'No repository worktrees are registered with Friday.',
    )
    // Entries group under their owning repository, sorted within the group.
    assert.strictEqual(
      renderWorktreeList([
        {
          url: 'git@github.com:one-terrace/timezone-relay-bot.git',
          commonDirectory: '/home/friday/.friday/repositories/cache.git',
          path: '/tmp/channel/timezone-relay-bot',
          branch: null,
          head: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
          prunable: true,
        },
        {
          url: 'git@github.com:one-terrace/second-repo.git',
          commonDirectory: '/home/friday/.friday/repositories/cache-2.git',
          path: '/tmp/channel/second-repo',
          branch: 'friday/channel/def456',
          head: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1',
          prunable: false,
        },
        {
          url: 'git@github.com:one-terrace/second-repo.git',
          commonDirectory: '/home/friday/.friday/repositories/cache-2.git',
          path: '/tmp/channel/another-second',
          branch: 'friday/channel/abc123',
          head: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2',
          prunable: false,
        },
      ]),
      [
        'Repository worktrees:',
        '  git@github.com:one-terrace/second-repo.git',
        '    /tmp/channel/another-second  friday/channel/abc123  c3d4e5f6a7b8',
        '    /tmp/channel/second-repo  friday/channel/def456  b2c3d4e5f6a7',
        '  git@github.com:one-terrace/timezone-relay-bot.git',
        '    /tmp/channel/timezone-relay-bot  (detached head)  a1b2c3d4e5f6  (missing on disk)',
      ].join('\n'),
    )
    assert.strictEqual(
      renderWorkspaceCleanupList([]),
      'No workspace cleanup proposals are recorded.',
    )
    assert.strictEqual(
      renderWorkspaceCleanupList([
        {
          id: decodeCleanupProposalId('cleanup-2'),
          threadId: decodeThreadId('task-2'),
          status: 'applied',
          workspacePath: '/tmp/channel',
          estimatedBytes: 10,
          createdAt: '2025-01-01T00:00:00Z',
          appliedAt: '2025-01-02T00:00:00Z',
          summary: 'Applied.',
          resources: [],
        },
      ]),
      [
        'Workspace cleanup proposals:',
        '  cleanup-2  applied  Applied.',
        '    Workspace: /tmp/channel',
      ].join('\n'),
    )
  }),
)

it.effect('formats Discord connection update outcomes with exact guidance', () =>
  Effect.sync(() => {
    const connectionId = decodeConnectionId('discord-main')
    assert.strictEqual(
      formatDiscordConnectionUpdate(connectionId, 'updated'),
      `Discord connection discord-main updated. Restart Friday to apply it: connection topology is pinned at startup.`,
    )
    assert.strictEqual(
      formatDiscordConnectionUpdate(connectionId, 'unchanged'),
      'Discord connection discord-main already has the requested configuration; nothing changed.',
    )
    assert.strictEqual(
      formatDiscordConnectionUpdate(connectionId, 'application-exists'),
      'The application ID is already used by another Discord connection.',
    )
    assert.strictEqual(
      formatDiscordConnectionUpdate(connectionId, 'missing'),
      'Discord connection discord-main is not configured.',
    )
  }),
)

it.effect('dispatches listings to exactly one read with the json flag honored', () =>
  Effect.gen(function* () {
    const guilds = [
      {
        guildId: '111111111111111111',
        enabled: true,
        invocation: { defaultMode: 'mention-only' as const },
        channels: [],
      },
    ]

    const listJson = recorder(guilds)
    yield* runFridayCli(['config', 'discord', 'guild', 'list', 'discord', '--json'], {
      ...strictRunnerStubs,
      listDiscordGuilds: listJson.operation,
    })
    assert.deepStrictEqual(listJson.calls, [[decodeConnectionId('discord')]])
    assert.strictEqual(yield* lastLine, JSON.stringify(guilds))

    const listHuman = recorder(guilds)
    yield* runFridayCli(['config', 'discord', 'guild', 'list', 'discord'], {
      ...strictRunnerStubs,
      listDiscordGuilds: listHuman.operation,
    })
    assert.deepStrictEqual(listHuman.calls, [[decodeConnectionId('discord')]])
    // The human listing names the guild rather than emitting JSON.
    const lastHuman = yield* lastLine
    assert.match(lastHuman, /guild 111111111111111111/)
    assert(!lastHuman.startsWith('['))

    // Connection listings dispatch the same way.
    const connections = [{ connectionId: 'discord', name: 'Discord', enabled: true }]
    const listConnectionsJson = recorder(connections)
    yield* runFridayCli(['config', 'discord', 'connection', 'list', '--json'], {
      ...strictRunnerStubs,
      listDiscordConnections: listConnectionsJson.operation,
    })
    assert.deepStrictEqual(listConnectionsJson.calls, [[]])
    assert.strictEqual(yield* lastLine, JSON.stringify(connections))

    const listConnectionsHuman = recorder(connections)
    yield* runFridayCli(['config', 'discord', 'connection', 'list'], {
      ...strictRunnerStubs,
      listDiscordConnections: listConnectionsHuman.operation,
    })
    assert.deepStrictEqual(listConnectionsHuman.calls, [[]])
    assert.match(yield* lastLine, /Discord connections:/)

    // A found connection get prints its stored configuration as JSON.
    const detail = {
      connectionId: 'discord-main',
      name: 'Main bot',
      enabled: true,
      applicationId: '111111111111111111',
      publicKey: '0123456789abcdef'.repeat(4),
      botTokenEnv: 'FRIDAY_DISCORD_TOKEN',
      respondToGlobalMentions: false,
      activityDescription: false,
    }
    const get = recorder(Option.some(detail))
    yield* runFridayCli(['config', 'discord', 'connection', 'get', 'discord-main', '--json'], {
      ...strictRunnerStubs,
      getDiscordConnection: get.operation,
    })
    assert.deepStrictEqual(get.calls, [[decodeConnectionId('discord-main')]])
    assert.strictEqual(yield* lastLine, JSON.stringify(detail))

    // A missing connection reports its absence without failing.
    const getMissing = recorder(Option.none())
    yield* runFridayCli(['config', 'discord', 'connection', 'get', 'discord-main'], {
      ...strictRunnerStubs,
      getDiscordConnection: getMissing.operation,
    })
    assert.deepStrictEqual(getMissing.calls, [[decodeConnectionId('discord-main')]])
    assert.match(yield* lastLine, /is not configured\./)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('rejects unknown commands', () =>
  Effect.gen(function* () {
    const exit = yield* parseFridayCli(['wat']).pipe(Effect.exit)
    assert(Exit.isFailure(exit))
    const error = Exit.findErrorOption(exit)
    assert(Option.isSome(error))
    assert(isFridayCliError(error.value))
    assert.strictEqual(error.value.argument, 'wat')
  }),
)

it.effect('renders help per topic: full tree, branch children, leaf usage, and fallback', () =>
  Effect.sync(() => {
    const help = renderCliHelp([])
    // Every leaf command path appears exactly once with its usage fragment.
    const leafPaths = [
      'start',
      'config reload',
      'config admin discord add <user-id>',
      'config admin discord remove <user-id>',
      'config admin discord list [--json]',
      'config discord connection add <connection-id>',
      'config discord connection update <connection-id>',
      'config discord connection remove <connection-id> --yes',
      'config discord connection enable <connection-id>',
      'config discord connection disable <connection-id>',
      'config discord connection get <connection-id> [--json]',
      'config discord connection list [--json]',
      'config discord guild enable <connection-id> <guild-id>',
      'config discord guild disable <connection-id> <guild-id>',
      'config discord guild remove <connection-id> <guild-id> --yes',
      'config discord guild list <connection-id> [--json]',
      'config discord guild set-invocation <connection-id> <guild-id>',
      'config discord guild set-users <connection-id> <guild-id>',
      'config discord guild channel set <connection-id> <guild-id> <channel-id>',
      'config discord guild channel reset <connection-id> <guild-id> <channel-id>',
      'config discord activity-description set <connection-id>',
      'config discord activity-description reset <connection-id>',
      'worktree ensure <repository-url> [--ref <ref>] [--workspace <path>] [--json]',
      'worktree list [--json]',
      'workspace cleanup apply <proposal-id> [--json]',
      'workspace cleanup list [--json]',
    ]
    for (const path of leafPaths) {
      assert.strictEqual(
        help.split(`  ${path}`).length - 1,
        1,
        `expected exactly one '${path}' entry in help`,
      )
    }
    // The header renders exactly, one blank line between each block.
    assert.strictEqual(
      help.split('\n').slice(0, 6).join('\n'),
      ['Friday — your personal agent', '', 'Usage:', '  friday [command]', '', 'Commands:'].join(
        '\n',
      ),
    )
    assert(help.includes('Notes:'))
    assert(
      help.includes(
        'Permission policies are "all", "allow=<id>[,<id>...]", or "deny=<id>[,<id>...]".',
      ),
    )
    assert(help.includes('-v, --version  Show the version'))
    assert(
      help.includes('  -h, --help     Show help; add a command prefix for help on that command'),
    )
    // The default command renders as a bare leaf entry with no usage fragment.
    assert.ok(help.split('\n').includes('  start'))
    assert(!help.includes('platform activity-description'))

    // A branch topic lists only its direct children, with usage for leaves.
    const discordHelp = renderCliHelp(['config', 'discord'])
    for (const entry of ['connection', 'guild', 'activity-description']) {
      assert(discordHelp.includes(`  ${entry}`), `expected '${entry}' in config discord help`)
    }
    assert(!discordHelp.includes('worktree'))
    assert(!discordHelp.includes('admin'))

    // A small branch topic renders its children exactly.
    assert.strictEqual(
      renderCliHelp(['workspace', 'cleanup']),
      [
        'Apply or inspect workspace cleanup proposals.',
        '',
        'Commands:',
        '  apply <proposal-id> [--json]',
        '      Apply an approved workspace cleanup proposal.',
        '  list [--json]',
        '      List recorded workspace cleanup proposals.',
      ].join('\n'),
    )

    // A nested branch topic lists its own children only.
    const channelHelp = renderCliHelp(['config', 'discord', 'guild', 'channel'])
    assert.match(channelHelp, /set <connection-id> <guild-id> <channel-id>/)
    assert.match(channelHelp, /reset <connection-id> <guild-id> <channel-id>/)
    assert(!channelHelp.includes('set-invocation'))

    // A leaf topic shows the exact usage lines without a command listing.
    assert.strictEqual(
      renderCliHelp(['worktree', 'list']),
      [
        'List repository worktrees registered with Friday.',
        '',
        'Usage:',
        '  friday worktree list [--json]',
      ].join('\n'),
    )

    // A multi-line leaf usage continues on indented lines.
    const setChannelHelp = renderCliHelp(['config', 'discord', 'guild', 'channel', 'set'])
    assert.match(
      setChannelHelp,
      /friday config discord guild channel set <connection-id> <guild-id> <channel-id>\n {6}\[--invocation <mention-only\|all-messages>\] \[--users <policy>\]\n {6}\[--reply-in-thread\|--reply-in-channel\]/,
    )

    // An unknown topic falls back to the full listing.
    assert.strictEqual(renderCliHelp(['nope']), help)
  }),
)

it.effect('names known subcommands and removals with exact guidance', () =>
  Effect.gen(function* () {
    const unknownOperation = yield* parseFridayCli([
      'config',
      'admin',
      'discord',
      'upsert',
      '123456789012345678',
    ]).pipe(Effect.flip)
    assert.strictEqual(
      unknownOperation.message,
      "Unknown 'friday config admin discord' subcommand 'upsert'. Known subcommands: add, remove, list.",
    )

    const unknownWorktree = yield* parseFridayCli(['worktree', 'dance']).pipe(Effect.flip)
    assert.strictEqual(
      unknownWorktree.message,
      "Unknown 'friday worktree' subcommand 'dance'. Known subcommands: ensure, list.",
    )

    const removedPlatform = yield* parseFridayCli([
      'platform',
      'activity-description',
      'set',
      'discord',
    ]).pipe(Effect.flip)
    assert.strictEqual(
      removedPlatform.message,
      "The 'platform activity-description set|reset' command was removed; use 'friday config discord activity-description set|reset <connection-id>' instead.",
    )

    const removedInvocation = yield* parseFridayCli([
      'config',
      'discord',
      'guild',
      'invocation',
      'set',
      'discord',
      '111111111111111111',
      'all-messages',
    ]).pipe(Effect.flip)
    assert.strictEqual(
      removedInvocation.message,
      "The 'config discord guild invocation set' command was removed; use 'friday config discord guild set-invocation <connection-id> <guild-id> <mode>' instead.",
    )

    const removedUsers = yield* parseFridayCli([
      'config',
      'discord',
      'guild',
      'users',
      'set',
      'discord',
      '111111111111111111',
      'all',
    ]).pipe(Effect.flip)
    assert.strictEqual(
      removedUsers.message,
      "The 'config discord guild users set' command was removed; use 'friday config discord guild set-users <connection-id> <guild-id> <policy>' instead.",
    )

    const guildRemoveRefusal = yield* parseFridayCli([
      'config',
      'discord',
      'guild',
      'remove',
      'discord',
      '111111111111111111',
    ]).pipe(Effect.flip)
    assert.strictEqual(
      guildRemoveRefusal.message,
      "Guild removal also deletes the guild's channel overrides; re-run with --yes to confirm.",
    )

    const updateRefusal = yield* parseFridayCli([
      'config',
      'discord',
      'connection',
      'update',
      'discord-main',
    ]).pipe(Effect.flip)
    assert.strictEqual(
      updateRefusal.message,
      'Provide at least one field to update: --name, --application-id, --public-key, --bot-token-env, --respond-to-global-mentions, or --no-respond-to-global-mentions.',
    )
  }),
)

it.effect('parses renamed guild set-invocation and set-users commands strictly', () =>
  Effect.gen(function* () {
    const invalid: ReadonlyArray<ReadonlyArray<string>> = [
      ['config', 'discord', 'guild', 'set-invocation', 'discord', '111111111111111111'],
      [
        'config',
        'discord',
        'guild',
        'set-invocation',
        'discord',
        '111111111111111111',
        'all-messages',
        'extra',
      ],
      ['config', 'discord', 'guild', 'set-invocation', 'discord', '111111111111111111', 'loud'],
      ['config', 'discord', 'guild', 'set-invocation', '--flag', '111111111111111111', 'loud'],
      ['config', 'discord', 'guild', 'set-users', 'discord', '111111111111111111'],
      ['config', 'discord', 'guild', 'set-users', 'discord', '111111111111111111', 'sometimes'],
      ['config', 'discord', 'guild', 'set-users', 'discord', '111111111111111111', 'allow='],
      ['config', 'discord', 'guild', 'set-users', 'discord', '111111111111111111', 'allow=abc'],
      ['config', 'discord', 'guild', 'set-users', 'discord', '111111111111111111', 'all', 'extra'],
    ]
    for (const arguments_ of invalid) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${arguments_.join(' ')}`)
    }
  }),
)

it.effect('rejects malformed connection updates precisely', () =>
  Effect.gen(function* () {
    const invalid: ReadonlyArray<ReadonlyArray<string>> = [
      ['config', 'discord', 'connection', 'update', 'discord-main', '--name', '--yes'], // flag-like value
      ['config', 'discord', 'connection', 'update', 'discord-main', '--public-key'], // missing trailing value
      [
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--application-id',
        '111111111111111111',
        '--application-id',
        '222222222222222222',
      ], // duplicate application id
      [
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--public-key',
        '0123456789abcdef'.repeat(4),
        '--public-key',
        'abcdef0123456789'.repeat(4),
      ], // duplicate public key
      [
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--bot-token-env',
        'A_TOKEN',
        '--bot-token-env',
        'B_TOKEN',
      ], // duplicate token env
      ['config', 'discord', 'connection', 'update', 'discord-main', '--name', '   '], // whitespace-only name
      ['config', 'discord', 'connection', 'update', '--flag', '--name', 'A'], // flag-like connection id
    ]
    for (const arguments_ of invalid) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${arguments_.join(' ')}`)
    }
  }),
)

it.effect('dispatches activity-description updates exactly once with live-apply guidance', () =>
  Effect.gen(function* () {
    const set = recorder(undefined)
    yield* runFridayCli(['config', 'discord', 'activity-description', 'set', 'discord'], {
      ...strictRunnerStubs,
      setDiscordActivityDescription: set.operation,
    })
    assert.deepStrictEqual(set.calls, [
      [
        {
          type: 'config-discord-activity-description-set',
          connectionId: decodeConnectionId('discord'),
        },
        true,
      ],
    ])
    const setLine = yield* lastLine
    assert.match(setLine, /discord enabled\./)
    assert.match(setLine, /within about a second/)
    assert(!setLine.includes('Restart Friday'))

    const reset = recorder(undefined)
    yield* runFridayCli(['config', 'discord', 'activity-description', 'reset', 'discord'], {
      ...strictRunnerStubs,
      setDiscordActivityDescription: reset.operation,
    })
    assert.deepStrictEqual(reset.calls, [
      [
        {
          type: 'config-discord-activity-description-reset',
          connectionId: decodeConnectionId('discord'),
        },
        false,
      ],
    ])
    assert.match(yield* lastLine, /Friday-owned text will be cleared\./)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('refuses guild removal before any dispatch without --yes', () =>
  Effect.gen(function* () {
    const remove = recorder('removed' as const)
    const refusal = yield* runFridayCli(
      ['config', 'discord', 'guild', 'remove', 'discord', '111111111111111111'],
      { ...strictRunnerStubs, removeDiscordGuild: remove.operation },
    ).pipe(Effect.flip)
    assert(isFridayCliError(refusal))
    assert.deepStrictEqual(remove.calls, [])
    assert.match(refusal.message, /--yes/)
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('parses help topics after flags and inside worktree commands', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['worktree', 'ensure', '--help']), {
      type: 'help',
      topic: ['worktree', 'ensure'],
    })
    assert.deepStrictEqual(yield* parseFridayCli(['workspace', 'cleanup', '--help']), {
      type: 'help',
      topic: ['workspace', 'cleanup'],
    })
    assert.deepStrictEqual(yield* parseFridayCli(['--help', 'config']), {
      type: 'help',
      topic: [],
    })
  }),
)

it.effect('rejects removed-flag and arity mistakes across lifecycle commands', () =>
  Effect.gen(function* () {
    const invalid: ReadonlyArray<ReadonlyArray<string>> = [
      ['config', 'discord', 'connection', 'remove', 'discord-main', '--no'],
      ['config', 'discord', 'connection', 'remove', 'discord-main', '--yes', 'extra'],
      ['config', 'discord', 'connection', 'add', 'discord-main', '--name', 'Only name'],
      [
        'config',
        'discord',
        'connection',
        'add',
        'discord-main',
        '--name',
        'A',
        '--application-id',
        '111111111111111111',
      ],
      [
        'config',
        'discord',
        'connection',
        'update',
        'discord-main',
        '--respond-to-global-mentions',
        '--respond-to-global-mentions',
      ],
      ['config', 'discord', 'activity-description', 'set', 'discord', 'extra'],
      ['config', 'discord', 'connection', 'get', 'discord-main', 'extra'],
      ['config', 'discord', 'connection', 'get', 'discord-main', '--json', '--json'],
      ['config', 'discord', 'guild', 'remove', 'discord'],
      ['config', 'discord', 'guild', 'remove', 'discord', '111111111111111111', '--no'],
      ['config', 'discord', 'guild', 'remove', 'discord', '111111111111111111', '--yes', 'extra'],
    ]
    for (const arguments_ of invalid) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${arguments_.join(' ')}`)
    }
  }),
)

it.effect('parses every worktree ensure flag combination', () =>
  Effect.gen(function* () {
    const url = decodeRepositoryUrl('git@github.com:one-terrace/timezone-relay-bot.git')
    const base = ['worktree', 'ensure', 'git@github.com:one-terrace/timezone-relay-bot.git']
    assert.deepStrictEqual(yield* parseFridayCli(base), {
      type: 'worktree-ensure',
      url,
      json: false,
    })
    assert.deepStrictEqual(yield* parseFridayCli([...base, '--json']), {
      type: 'worktree-ensure',
      url,
      json: true,
    })
    assert.deepStrictEqual(yield* parseFridayCli([...base, '--ref', 'main']), {
      type: 'worktree-ensure',
      url,
      ref: 'main',
      json: false,
    })
    assert.deepStrictEqual(yield* parseFridayCli([...base, '--workspace', '/tmp/channel']), {
      type: 'worktree-ensure',
      url,
      workspace: '/tmp/channel',
      json: false,
    })
    const invalid = [
      [...base, '--workspace'], // missing value
      [...base, '--ref', '--json'], // flag-like ref
      ['worktree', 'ensure', '--json'], // flag-like url
    ]
    for (const arguments_ of invalid) {
      const error = yield* parseFridayCli(arguments_).pipe(Effect.flip)
      assert(isFridayCliError(error), `expected failure: ${arguments_.join(' ')}`)
    }
  }),
)

it.effect(
  'dispatches start, worktree ensure, and cleanup apply to exactly one operation each',
  () =>
    Effect.gen(function* () {
      // The start effect runs exactly once; it dies so the runner surfaces it.
      let started = false
      const startExit = yield* runFridayCli(['start'], {
        ...strictRunnerStubs,
        start: Effect.suspend(() => {
          started = true
          return Effect.die('start ran')
        }),
      }).pipe(Effect.exit)
      assert(started)
      assert(Exit.isFailure(startExit))

      const ensure = recorder({
        url: decodeRepositoryUrl('git@github.com:one-terrace/timezone-relay-bot.git'),
        path: '/tmp/channel/timezone-relay-bot',
        branch: 'friday/channel/abc123',
        baseRef: 'origin/main',
        commonDirectory: '/home/friday/.friday/repositories/cache.git',
        reused: false,
      })
      yield* runFridayCli(
        ['worktree', 'ensure', 'git@github.com:one-terrace/timezone-relay-bot.git', '--json'],
        { ...strictRunnerStubs, ensureWorktree: ensure.operation },
      )
      assert.strictEqual(
        yield* lastLine,
        JSON.stringify({
          url: 'git@github.com:one-terrace/timezone-relay-bot.git',
          path: '/tmp/channel/timezone-relay-bot',
          branch: 'friday/channel/abc123',
          baseRef: 'origin/main',
          commonDirectory: '/home/friday/.friday/repositories/cache.git',
          reused: false,
        }),
      )

      yield* runFridayCli(
        ['worktree', 'ensure', 'git@github.com:one-terrace/timezone-relay-bot.git'],
        { ...strictRunnerStubs, ensureWorktree: ensure.operation },
      )
      const humanEnsure = yield* lastLine
      assert.match(humanEnsure, /Repository worktree ready/)
      assert.match(humanEnsure, /Reused: no/)
    }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('dispatches workspace cleanup apply and renders the applied proposal', () =>
  Effect.gen(function* () {
    const proposal = {
      id: decodeCleanupProposalId('cleanup-9'),
      threadId: decodeThreadId('task-9'),
      status: 'applied' as const,
      workspacePath: '/tmp/channel',
      estimatedBytes: 2048,
      createdAt: '2025-01-01T00:00:00Z',
      appliedAt: '2025-01-02T00:00:00Z',
      summary: '1 repository worktree, 0 with uncommitted files, approximately 2048 bytes.',
      resources: [],
    }
    const apply = recorder(proposal)
    yield* runFridayCli(['workspace', 'cleanup', 'apply', 'cleanup-9'], {
      ...strictRunnerStubs,
      applyWorkspaceCleanup: apply.operation,
    })
    assert.deepStrictEqual(apply.calls, [
      [
        {
          type: 'workspace-cleanup-apply',
          proposalId: decodeCleanupProposalId('cleanup-9'),
          json: false,
        },
        process.cwd(),
      ],
    ])
    const human = yield* lastLine
    assert.match(human, /Workspace cleanup applied/)
    assert.match(human, /Proposal: cleanup-9/)
    assert.match(human, /Estimated reclaimed: 2048 bytes/)

    const applyJson = recorder(proposal)
    yield* runFridayCli(['workspace', 'cleanup', 'apply', 'cleanup-9', '--json'], {
      ...strictRunnerStubs,
      applyWorkspaceCleanup: applyJson.operation,
    })
    assert.strictEqual(yield* lastLine, JSON.stringify(proposal))
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('renders connection details across the boolean combinations', () =>
  Effect.sync(() => {
    const base = {
      connectionId: 'discord-main',
      name: 'Main bot',
      applicationId: '111111111111111111',
      publicKey: '0123456789abcdef'.repeat(4),
      botTokenEnv: 'FRIDAY_DISCORD_TOKEN',
    }
    assert.strictEqual(
      renderDiscordConnectionDetail({
        ...base,
        enabled: false,
        respondToGlobalMentions: false,
        activityDescription: true,
      }),
      [
        'Discord connection discord-main:',
        '  Name: Main bot',
        '  Enabled: no',
        '  Application ID: 111111111111111111',
        `  Public key: ${'0123456789abcdef'.repeat(4)}`,
        '  Bot token env: FRIDAY_DISCORD_TOKEN',
        '  Responds to global mentions: no',
        '  Public activity description: yes',
      ].join('\n'),
    )
  }),
)
