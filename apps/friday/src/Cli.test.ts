import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as TestConsole from 'effect/testing/TestConsole'

import {
  ConfigReloadRejectedError,
  FridayCliError,
  formatDiscordAdminAdd,
  formatDiscordAdminRemove,
  formatDiscordGuildChannelReset,
  formatDiscordGuildChannelSet,
  formatDiscordGuildDisable,
  formatDiscordGuildEnable,
  formatDiscordGuildInvocation,
  formatDiscordGuildRemove,
  formatDiscordGuildUsers,
  FRIDAY_VERSION,
  helpText,
  parseAccessPolicySpec,
  parseFridayCli,
  renderDiscordAdminList,
  renderDiscordConnectionList,
  renderDiscordGuildList,
  runFridayCli,
} from './Cli.ts'
import { DiscordGuildChannelId, DiscordGuildId } from './config/DiscordGuilds.ts'
import { InvocationMode } from './config/AppConfig.ts'
import { reloadFailed, reloadSucceeded } from './config/ConfigReload.ts'
import {
  DiscordUserId,
  type DiscordAdminAddOutcome,
  type DiscordAdminRemoveOutcome,
} from './config/DiscordAdmins.ts'
import { ControlSocketError } from './control/ControlSocket.ts'
import { PlatformConnectionId } from '@friday/contracts/conversation'
import { RepositoryUrl } from './repositories/RepositoryWorktrees.ts'
import { WorkspaceCleanupProposalId } from './workspaces/WorkspaceCleanup.ts'

const isFridayCliError = Schema.is(FridayCliError)
const isConfigReloadRejectedError = Schema.is(ConfigReloadRejectedError)
const isControlSocketError = Schema.is(ControlSocketError)
const decodeRepositoryUrl = Schema.decodeSync(RepositoryUrl)
const decodeCleanupProposalId = Schema.decodeSync(WorkspaceCleanupProposalId)
const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeDiscordUserId = Schema.decodeSync(DiscordUserId)
const decodeGuildId = Schema.decodeSync(DiscordGuildId)
const decodeChannelId = Schema.decodeSync(DiscordGuildChannelId)
const decodeMode = Schema.decodeSync(InvocationMode)

/** Runs the CLI with every unrelated command failing loudly. */
/** Guild runner stubs shared by the command-dispatch tests. */
const guildRunnerStubs = {
  start: Effect.die('start must not run'),
  reloadConfig: Effect.die('unreachable'),
  ensureWorktree: () => Effect.die('unreachable'),
  setDiscordActivityDescription: () => Effect.die('unreachable'),
  applyWorkspaceCleanup: () => Effect.die('unreachable'),
  addDiscordAdmin: () => Effect.die('unreachable'),
  removeDiscordAdmin: () => Effect.die('unreachable'),
  listDiscordAdmins: () => Effect.die('unreachable'),
  listDiscordConnections: () =>
    Effect.succeed([{ connectionId: 'discord', name: 'Discord', enabled: true }]),
  listDiscordGuilds: () =>
    Effect.succeed([
      {
        guildId: '111111111111111111',
        enabled: true,
        invocation: { defaultMode: 'mention-only' as const },
        channels: [],
      },
    ]),
  enableDiscordGuild: () => Effect.succeed('enabled' as const),
  disableDiscordGuild: () => Effect.succeed('disabled' as const),
  removeDiscordGuild: () => Effect.succeed('removed' as const),
  setDiscordGuildInvocation: () => Effect.succeed('updated' as const),
  setDiscordGuildUsers: () => Effect.succeed('updated' as const),
  setDiscordGuildChannel: () => Effect.succeed('updated' as const),
  resetDiscordGuildChannel: () => Effect.succeed('removed' as const),
}

const adminRunner = (add?: DiscordAdminAddOutcome, remove?: DiscordAdminRemoveOutcome) => ({
  ...guildRunnerStubs,
  addDiscordAdmin: () => Effect.succeed(add ?? 'exists'),
  removeDiscordAdmin: () => Effect.succeed(remove ?? 'missing'),
  listDiscordAdmins: () => Effect.succeed(['123456789012345678']),
})

it.effect('uses start as the default command', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli([]), { type: 'start' })
    assert.deepStrictEqual(yield* parseFridayCli(['start']), { type: 'start' })
  }),
)

it.effect('recognizes help without starting Friday', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['--help']), { type: 'help' })
    assert.deepStrictEqual(yield* parseFridayCli(['-h']), { type: 'help' })
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
      ]),
      { type: 'config-discord-guild-remove', connectionId, guildId },
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
        'invocation',
        'set',
        'discord',
        '111111111111111111',
        'all-messages',
      ]),
      {
        type: 'config-discord-guild-invocation-set',
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
        'users',
        'set',
        'discord',
        '111111111111111111',
        'allow=123456789012345678,234567890123456789',
      ]),
      {
        type: 'config-discord-guild-users-set',
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

it.effect('parses Discord activity-description configuration updates', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* parseFridayCli(['platform', 'activity-description', 'set', 'discord']),
      {
        type: 'platform-activity-description-set',
        connectionId: decodeConnectionId('discord'),
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['platform', 'activity-description', 'reset', 'discord']),
      {
        type: 'platform-activity-description-reset',
        connectionId: decodeConnectionId('discord'),
      },
    )
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

it.effect('parses the config reload command', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* parseFridayCli(['config', 'reload']), {
      type: 'config-reload',
    })
    const exit = yield* parseFridayCli(['config', 'reload', '--force']).pipe(Effect.exit)
    assert(Exit.isFailure(exit))
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
      const exit = yield* parseFridayCli(arguments_).pipe(Effect.exit)
      assert(Exit.isFailure(exit), `expected failure: ${arguments_.join(' ')}`)
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

it.effect('documents the Discord administrator commands in help output', () =>
  Effect.sync(() => {
    assert(helpText.includes('friday config admin discord add <user-id>'))
    assert(helpText.includes('friday config admin discord remove <user-id>'))
    assert(helpText.includes('friday config admin discord list [--json]'))
  }),
)

it.effect('documents the Discord guild configuration commands in help output', () =>
  Effect.sync(() => {
    assert(helpText.includes('friday config discord guild enable <connection-id> <guild-id>'))
    assert(helpText.includes('friday config discord guild channel set'))
    assert(helpText.includes('--reply-in-thread|--reply-in-channel'))
    assert(!helpText.includes('system-channel'))
    assert(!helpText.includes('platform invocation'))
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

it.effect('runs Discord admin commands through the admin operations', () =>
  Effect.gen(function* () {
    yield* runFridayCli(
      ['config', 'admin', 'discord', 'add', '123456789012345678'],
      adminRunner('added'),
    )
    yield* runFridayCli(
      ['config', 'admin', 'discord', 'remove', '123456789012345678'],
      adminRunner(undefined, 'removed'),
    )
    yield* runFridayCli(['config', 'admin', 'discord', 'list'], adminRunner())
    yield* runFridayCli(['config', 'admin', 'discord', 'list', '--json'], adminRunner())

    // Pinned literals: expectations do not reuse the production formatters.
    const lines = yield* TestConsole.logLines
    assert(
      lines.includes(
        'Discord admin 123456789012345678 added. Restart Friday to apply it: the admin allow-list is pinned at startup.',
      ),
    )
    assert(
      lines.includes(
        'Discord admin 123456789012345678 removed. Restart Friday to apply it: the admin allow-list is pinned at startup.',
      ),
    )
    assert(lines.includes('Discord administrators:\n  123456789012345678'))
    assert(lines.includes('["123456789012345678"]'))
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('runs the reload operation and reports rejections as typed errors', () =>
  Effect.gen(function* () {
    yield* runFridayCli(['config', 'reload'], {
      ...guildRunnerStubs,
      reloadConfig: Effect.succeed(reloadSucceeded(6)),
    })

    const rejected = yield* runFridayCli(['config', 'reload'], {
      ...guildRunnerStubs,
      reloadConfig: Effect.succeed(reloadFailed('Stored Friday configuration is invalid.')),
    }).pipe(Effect.flip)
    assert(isConfigReloadRejectedError(rejected))
    assert.match(rejected.message, /Stored Friday configuration is invalid\./)

    const transportError = yield* runFridayCli(['config', 'reload'], {
      ...guildRunnerStubs,
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
          channels: [],
        },
      ]),
      [
        'guild 111111111111111111: disabled, invocation: all-messages',
        '  channel 222222222222222222: invocation: mention-only, users: deny=333333333333333333, reply: reply-in-channel',
        '  channel 444444444444444444: (no overrides)',
        'guild 555555555555555555: enabled, invocation: mention-only, users: allow=333333333333333333,666666666666666666',
      ].join('\n'),
    )
  }),
)

it.effect('renders json and human listings for the exact command given', () =>
  Effect.gen(function* () {
    // logLines accumulate across the test, so each assertion pins the line the
    // preceding command just printed.
    const assertLastLine = (line: string) =>
      Effect.gen(function* () {
        const lines = yield* TestConsole.logLines
        assert.strictEqual(lines[lines.length - 1], line)
      })

    yield* runFridayCli(['config', 'discord', 'connection', 'list', '--json'], guildRunnerStubs)
    yield* assertLastLine('[{"connectionId":"discord","name":"Discord","enabled":true}]')

    yield* runFridayCli(['config', 'discord', 'connection', 'list'], guildRunnerStubs)
    yield* assertLastLine('Discord connections:\n  discord  enabled  Discord')

    yield* runFridayCli(
      ['config', 'discord', 'guild', 'list', 'discord', '--json'],
      guildRunnerStubs,
    )
    yield* assertLastLine(
      '[{"guildId":"111111111111111111","enabled":true,"invocation":{"defaultMode":"mention-only"},"channels":[]}]',
    )

    yield* runFridayCli(['config', 'discord', 'guild', 'list', 'discord'], guildRunnerStubs)
    yield* assertLastLine('guild 111111111111111111: enabled, invocation: mention-only')
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('runs Discord guild configuration commands through the guild operations', () =>
  Effect.gen(function* () {
    const guildArguments: ReadonlyArray<ReadonlyArray<string>> = [
      ['config', 'discord', 'guild', 'enable', 'discord', '111111111111111111'],
      ['config', 'discord', 'guild', 'disable', 'discord', '111111111111111111'],
      ['config', 'discord', 'guild', 'remove', 'discord', '111111111111111111'],
      ['config', 'discord', 'guild', 'list', 'discord'],
      ['config', 'discord', 'guild', 'list', 'discord', '--json'],
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
      [
        'config',
        'discord',
        'guild',
        'users',
        'set',
        'discord',
        '111111111111111111',
        'allow=333333333333333333',
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
        '--reply-in-channel',
      ],
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
    ]
    for (const arguments_ of guildArguments) {
      yield* runFridayCli(arguments_, guildRunnerStubs)
    }
    yield* runFridayCli(['--help'], guildRunnerStubs)
    yield* runFridayCli(['--version'], guildRunnerStubs)

    // Pinned literals: expectations do not reuse the production formatters.
    const lines = yield* TestConsole.logLines
    const expected = [
      'Guild 111111111111111111 enabled. The running Friday picks this up on its next configuration reload.',
      'Guild 111111111111111111 disabled. The running Friday picks this up on its next configuration reload.',
      'Guild 111111111111111111 removed together with its channel overrides. The running Friday picks this up on its next configuration reload.',
      'Guild-wide invocation default for 111111111111111111 set to all-messages. The running Friday picks this up on its next configuration reload.',
      'Guild-wide user permission default for 111111111111111111 set to allow=333333333333333333. The running Friday picks this up on its next configuration reload.',
      'Channel 222222222222222222 overrides updated. The running Friday picks this up on its next configuration reload.',
      'Channel 222222222222222222 overrides removed; guild defaults apply. The running Friday picks this up on its next configuration reload.',
    ]
    for (const line of expected) {
      assert(lines.includes(line), `missing output: ${line}`)
    }
    assert(lines.includes(helpText.trimEnd()))
    assert(lines.includes(FRIDAY_VERSION))
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
