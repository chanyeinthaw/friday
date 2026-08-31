import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { ConfigReloadRejectedError, FridayCliError, parseFridayCli, runFridayCli } from './Cli.ts'
import { reloadFailed, reloadSucceeded } from './config/ConfigReload.ts'
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

it.effect('runs the reload operation and reports rejections as typed errors', () =>
  Effect.gen(function* () {
    yield* runFridayCli(['config', 'reload'], {
      start: Effect.die('start must not run'),
      reloadConfig: Effect.succeed(reloadSucceeded(6)),
      ensureWorktree: () => Effect.die('unreachable'),
      setPlatformInvocation: () => Effect.die('unreachable'),
      setPlatformSystemChannel: () => Effect.die('unreachable'),
      setDiscordActivityDescription: () => Effect.die('unreachable'),
      applyWorkspaceCleanup: () => Effect.die('unreachable'),
    })

    const rejected = yield* runFridayCli(['config', 'reload'], {
      start: Effect.die('start must not run'),
      reloadConfig: Effect.succeed(reloadFailed('Stored Friday configuration is invalid.')),
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
