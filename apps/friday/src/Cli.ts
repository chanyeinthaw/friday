import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { RepositoryUrl, type ManagedWorktree } from './repositories/RepositoryWorktrees.ts'
import {
  WorkspaceCleanupProposalId,
  type WorkspaceCleanupProposal,
} from './workspaces/WorkspaceCleanup.ts'

export const FRIDAY_VERSION = '0.1.0'

export const helpText = `Friday — your personal agent

Usage:
  friday [command]
  friday worktree ensure <repository-url> [--ref <ref>] [--workspace <path>] [--json]
  friday workspace cleanup apply <proposal-id> [--json]

Commands:
  start             Start Friday (default)
  worktree ensure          Ensure a reusable repository worktree for the current channel workspace
  workspace cleanup apply  Apply an approved workspace cleanup proposal

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`

export type FridayCliAction =
  | { readonly type: 'help' }
  | { readonly type: 'start' }
  | { readonly type: 'version' }
  | {
      readonly type: 'workspace-cleanup-apply'
      readonly proposalId: WorkspaceCleanupProposalId
      readonly json: boolean
    }
  | {
      readonly type: 'worktree-ensure'
      readonly url: RepositoryUrl
      readonly workspace?: string
      readonly ref?: string
      readonly json: boolean
    }

export class FridayCliError extends Schema.Error<FridayCliError>('FridayCliError')({
  _tag: Schema.tag('FridayCliError'),
  argument: Schema.String,
}) {
  override get message(): string {
    return `Unknown or invalid Friday command: ${this.argument}`
  }
}

const decodeRepositoryUrl = Schema.decodeUnknownEffect(RepositoryUrl)
const decodeWorkspaceCleanupProposalId = Schema.decodeUnknownEffect(WorkspaceCleanupProposalId)

const parseWorktreeEnsure = Effect.fn('Cli.parseWorktreeEnsure')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const urlArgument = arguments_[2]
  if (!urlArgument || urlArgument.startsWith('-')) {
    return yield* new FridayCliError({ argument: arguments_.join(' ') })
  }
  const url = yield* decodeRepositoryUrl(urlArgument).pipe(
    Effect.mapError(() => new FridayCliError({ argument: arguments_.join(' ') })),
  )
  let workspace: string | undefined
  let ref: string | undefined
  let json = false
  for (let index = 3; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--json') {
      json = true
      continue
    }
    if (argument === '--workspace' || argument === '--ref') {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('-')) {
        return yield* new FridayCliError({ argument: arguments_.join(' ') })
      }
      if (argument === '--workspace') workspace = value
      else ref = value
      index += 1
      continue
    }
    return yield* new FridayCliError({ argument: arguments_.join(' ') })
  }
  if (workspace !== undefined && ref !== undefined) {
    return { type: 'worktree-ensure' as const, url, workspace, ref, json }
  }
  if (workspace !== undefined) return { type: 'worktree-ensure' as const, url, workspace, json }
  if (ref !== undefined) return { type: 'worktree-ensure' as const, url, ref, json }
  return { type: 'worktree-ensure' as const, url, json }
})

const parseWorkspaceCleanupApply = Effect.fn('Cli.parseWorkspaceCleanupApply')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const proposalArgument = arguments_[3]
  if (!proposalArgument || proposalArgument.startsWith('-')) {
    return yield* new FridayCliError({ argument: arguments_.join(' ') })
  }
  const proposalId = yield* decodeWorkspaceCleanupProposalId(proposalArgument).pipe(
    Effect.mapError(() => new FridayCliError({ argument: arguments_.join(' ') })),
  )
  const trailing = arguments_.slice(4)
  if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '--json')) {
    return yield* new FridayCliError({ argument: arguments_.join(' ') })
  }
  return { type: 'workspace-cleanup-apply' as const, proposalId, json: trailing[0] === '--json' }
})

export const parseFridayCli = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<FridayCliAction, FridayCliError> => {
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === 'start')) {
    return Effect.succeed({ type: 'start' })
  }
  if (arguments_.length === 1 && (arguments_[0] === '--help' || arguments_[0] === '-h')) {
    return Effect.succeed({ type: 'help' })
  }
  if (arguments_.length === 1 && (arguments_[0] === '--version' || arguments_[0] === '-v')) {
    return Effect.succeed({ type: 'version' })
  }
  if (arguments_[0] === 'worktree' && arguments_[1] === 'ensure') {
    return parseWorktreeEnsure(arguments_)
  }
  if (arguments_[0] === 'workspace' && arguments_[1] === 'cleanup' && arguments_[2] === 'apply') {
    return parseWorkspaceCleanupApply(arguments_)
  }
  return Effect.fail(new FridayCliError({ argument: arguments_.join(' ') }))
}

const renderCleanup = (proposal: WorkspaceCleanupProposal): string => `Workspace cleanup applied
  Proposal: ${proposal.id}
  Worktrees: ${proposal.resources.length}
  Reclaimed: ${proposal.estimatedBytes} bytes`

const renderWorktree = (worktree: ManagedWorktree): string => `Repository worktree ready
  URL: ${worktree.url}
  Path: ${worktree.path}
  Branch: ${worktree.branch}
  Base: ${worktree.baseRef}
  Reused: ${worktree.reused ? 'yes' : 'no'}`

export const runFridayCli = <E, WorktreeError, CleanupError>(
  arguments_: ReadonlyArray<string>,
  options: {
    readonly start: Effect.Effect<never, E>
    readonly ensureWorktree: (
      action: Extract<FridayCliAction, { readonly type: 'worktree-ensure' }>,
    ) => Effect.Effect<ManagedWorktree, WorktreeError>
    readonly applyWorkspaceCleanup: (
      action: Extract<FridayCliAction, { readonly type: 'workspace-cleanup-apply' }>,
      currentWorkingDirectory: string,
    ) => Effect.Effect<WorkspaceCleanupProposal, CleanupError>
  },
): Effect.Effect<void, FridayCliError | E | WorktreeError | CleanupError> =>
  Effect.gen(function* () {
    const action = yield* parseFridayCli(arguments_)
    switch (action.type) {
      case 'help':
        yield* Console.log(helpText.trimEnd())
        return
      case 'version':
        yield* Console.log(FRIDAY_VERSION)
        return
      case 'workspace-cleanup-apply': {
        const result = yield* options.applyWorkspaceCleanup(action, process.cwd())
        yield* Console.log(action.json ? JSON.stringify(result) : renderCleanup(result))
        return
      }
      case 'worktree-ensure': {
        const result = yield* options.ensureWorktree(action)
        yield* Console.log(action.json ? JSON.stringify(result) : renderWorktree(result))
        return
      }
      case 'start':
        return yield* options.start
    }
  })
