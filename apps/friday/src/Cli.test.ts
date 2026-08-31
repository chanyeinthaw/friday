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
  helpText,
  parseFridayCli,
  renderDiscordAdminList,
  runFridayCli,
} from './Cli.ts'
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

/** Runs the CLI with every unrelated command failing loudly. */
const adminRunner = (add?: DiscordAdminAddOutcome, remove?: DiscordAdminRemoveOutcome) => ({
  start: Effect.die('start must not run'),
  reloadConfig: Effect.die('unreachable'),
  ensureWorktree: () => Effect.die('unreachable'),
  setPlatformInvocation: () => Effect.die('unreachable'),
  setPlatformSystemChannel: () => Effect.die('unreachable'),
  setDiscordActivityDescription: () => Effect.die('unreachable'),
  applyWorkspaceCleanup: () => Effect.die('unreachable'),
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

it.effect('parses a channel invocation policy update', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* parseFridayCli([
        'platform',
        'invocation',
        'set',
        'discord',
        'channel-1',
        'mention-only',
      ]),
      {
        type: 'platform-invocation-set',
        connectionId: decodeConnectionId('discord'),
        channelId: 'channel-1',
        mode: 'mention-only',
      },
    )
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

it.effect('parses system-channel configuration updates', () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* parseFridayCli(['platform', 'system-channel', 'set', 'discord', 'channel-1']),
      {
        type: 'platform-system-channel-set',
        connectionId: decodeConnectionId('discord'),
        channelId: 'channel-1',
      },
    )
    assert.deepStrictEqual(
      yield* parseFridayCli(['platform', 'system-channel', 'reset', 'discord', 'channel-1']),
      {
        type: 'platform-system-channel-reset',
        connectionId: decodeConnectionId('discord'),
        channelId: 'channel-1',
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

    const lines = yield* TestConsole.logLines
    assert(
      lines.includes(formatDiscordAdminAdd(decodeDiscordUserId('123456789012345678'), 'added')),
    )
    assert(
      lines.includes(
        formatDiscordAdminRemove(decodeDiscordUserId('123456789012345678'), 'removed'),
      ),
    )
    assert(lines.includes(renderDiscordAdminList(['123456789012345678'])))
    assert(lines.includes(JSON.stringify(['123456789012345678'])))
  }).pipe(Effect.provide(TestConsole.layer)),
)

it.effect('runs the reload operation and reports rejections as typed errors', () =>
  Effect.gen(function* () {
    yield* runFridayCli(['config', 'reload'], {
      start: Effect.die('start must not run'),
      reloadConfig: Effect.succeed(reloadSucceeded(6)),
      addDiscordAdmin: () => Effect.die('unreachable'),
      removeDiscordAdmin: () => Effect.die('unreachable'),
      listDiscordAdmins: () => Effect.die('unreachable'),
      ensureWorktree: () => Effect.die('unreachable'),
      setPlatformInvocation: () => Effect.die('unreachable'),
      setPlatformSystemChannel: () => Effect.die('unreachable'),
      setDiscordActivityDescription: () => Effect.die('unreachable'),
      applyWorkspaceCleanup: () => Effect.die('unreachable'),
    })

    const rejected = yield* runFridayCli(['config', 'reload'], {
      start: Effect.die('start must not run'),
      reloadConfig: Effect.succeed(reloadFailed('Stored Friday configuration is invalid.')),
      addDiscordAdmin: () => Effect.die('unreachable'),
      removeDiscordAdmin: () => Effect.die('unreachable'),
      listDiscordAdmins: () => Effect.die('unreachable'),
      ensureWorktree: () => Effect.die('unreachable'),
      setPlatformInvocation: () => Effect.die('unreachable'),
      setPlatformSystemChannel: () => Effect.die('unreachable'),
      setDiscordActivityDescription: () => Effect.die('unreachable'),
      applyWorkspaceCleanup: () => Effect.die('unreachable'),
    }).pipe(Effect.flip)
    assert(isConfigReloadRejectedError(rejected))
    assert.match(rejected.message, /Stored Friday configuration is invalid\./)

    const transportError = yield* runFridayCli(['config', 'reload'], {
      start: Effect.die('start must not run'),
      reloadConfig: Effect.fail(
        new ControlSocketError({
          operation: 'connect',
          path: '/tmp/friday.sock',
          detail: 'Could not connect to the running Friday control socket.',
        }),
      ),
      addDiscordAdmin: () => Effect.die('unreachable'),
      removeDiscordAdmin: () => Effect.die('unreachable'),
      listDiscordAdmins: () => Effect.die('unreachable'),
      ensureWorktree: () => Effect.die('unreachable'),
      setPlatformInvocation: () => Effect.die('unreachable'),
      setPlatformSystemChannel: () => Effect.die('unreachable'),
      setDiscordActivityDescription: () => Effect.die('unreachable'),
      applyWorkspaceCleanup: () => Effect.die('unreachable'),
    }).pipe(Effect.flip)
    assert(isControlSocketError(transportError))
    assert.strictEqual(transportError.operation, 'connect')
  }),
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
