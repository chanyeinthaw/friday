import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { FridayCliError, parseFridayCli } from './Cli.ts'
import { RepositoryUrl } from './repositories/RepositoryWorktrees.ts'
import { WorkspaceCleanupProposalId } from './workspaces/WorkspaceCleanup.ts'

const isFridayCliError = Schema.is(FridayCliError)
const decodeRepositoryUrl = Schema.decodeSync(RepositoryUrl)
const decodeCleanupProposalId = Schema.decodeSync(WorkspaceCleanupProposalId)

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
