import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { PlatformConnectionId } from '@friday/contracts/conversation'

import { InvocationMode, type InvocationMode as InvocationModeType } from './config/AppConfig.ts'
import {
  formatConfigReloadOutcome,
  type ConfigReloadOutcome as ConfigReloadOutcomeType,
} from './config/ConfigReload.ts'
import { RepositoryUrl, type ManagedWorktree } from './repositories/RepositoryWorktrees.ts'
import {
  WorkspaceCleanupProposalId,
  type WorkspaceCleanupProposal,
} from './workspaces/WorkspaceCleanup.ts'

export const FRIDAY_VERSION = '0.0.0-nightly.7'

export const helpText = `Friday — your personal agent

Usage:
  friday [command]
  friday config reload
  friday worktree ensure <repository-url> [--ref <ref>] [--workspace <path>] [--json]
  friday workspace cleanup apply <proposal-id> [--json]
  friday platform invocation set <connection-id> <channel-id> <mention-only|all-messages>
  friday platform activity-description set <connection-id>
  friday platform activity-description reset <connection-id>
  friday platform system-channel set <connection-id> <channel-id>
  friday platform system-channel reset <connection-id> <channel-id>

Commands:
  start             Start Friday (default)
  config reload            Reload the running Friday's configuration
  worktree ensure          Ensure a reusable repository worktree for the current channel workspace
  workspace cleanup apply  Apply an approved workspace cleanup proposal
  platform invocation set          Set one channel's invocation mode
  platform activity-description set   Enable public task activity now, without restarting Friday
  platform activity-description reset Disable it now and clear only Friday-owned description text
  platform system-channel set      Configure a direct system-management channel
  platform system-channel reset Remove system-management behavior from a channel

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`

export type FridayCliAction =
  | { readonly type: 'help' }
  | { readonly type: 'start' }
  | { readonly type: 'version' }
  | { readonly type: 'config-reload' }
  | {
      readonly type: 'platform-invocation-set'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly channelId: string
      readonly mode: InvocationModeType
    }
  | {
      readonly type: 'platform-activity-description-set' | 'platform-activity-description-reset'
      readonly connectionId: typeof PlatformConnectionId.Type
    }
  | {
      readonly type: 'platform-system-channel-set' | 'platform-system-channel-reset'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly channelId: string
    }
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

export class ConfigReloadRejectedError extends Schema.Error<ConfigReloadRejectedError>(
  'ConfigReloadRejectedError',
)({
  _tag: Schema.tag('ConfigReloadRejectedError'),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Configuration reload rejected: ${this.detail}`
  }
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
const decodePlatformConnectionId = Schema.decodeUnknownEffect(PlatformConnectionId)
const decodeInvocationMode = Schema.decodeUnknownEffect(InvocationMode)

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

const parsePlatformActivityDescription = Effect.fn('Cli.parsePlatformActivityDescription')(
  function* (arguments_: ReadonlyArray<string>) {
    const operation = arguments_[2]
    const connectionArgument = arguments_[3]
    if (
      arguments_.length !== 4 ||
      (operation !== 'set' && operation !== 'reset') ||
      !connectionArgument
    ) {
      return yield* new FridayCliError({ argument: arguments_.join(' ') })
    }
    const connectionId = yield* decodePlatformConnectionId(connectionArgument).pipe(
      Effect.mapError(() => new FridayCliError({ argument: arguments_.join(' ') })),
    )
    return {
      type: `platform-activity-description-${operation}` as const,
      connectionId,
    }
  },
)

const parsePlatformSystemChannel = Effect.fn('Cli.parsePlatformSystemChannel')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const operation = arguments_[2]
  const connectionArgument = arguments_[3]
  const channelId = arguments_[4]
  if (
    arguments_.length !== 5 ||
    (operation !== 'set' && operation !== 'reset') ||
    !connectionArgument ||
    !channelId
  ) {
    return yield* new FridayCliError({ argument: arguments_.join(' ') })
  }
  const connectionId = yield* decodePlatformConnectionId(connectionArgument).pipe(
    Effect.mapError(() => new FridayCliError({ argument: arguments_.join(' ') })),
  )
  return {
    type: `platform-system-channel-${operation}` as const,
    connectionId,
    channelId,
  }
})

const parsePlatformInvocationSet = Effect.fn('Cli.parsePlatformInvocationSet')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const connectionArgument = arguments_[3]
  const channelId = arguments_[4]
  const modeArgument = arguments_[5]
  if (arguments_.length !== 6 || !connectionArgument || !channelId || !modeArgument) {
    return yield* new FridayCliError({ argument: arguments_.join(' ') })
  }
  const connectionId = yield* decodePlatformConnectionId(connectionArgument).pipe(
    Effect.mapError(() => new FridayCliError({ argument: arguments_.join(' ') })),
  )
  const mode = yield* decodeInvocationMode(modeArgument).pipe(
    Effect.mapError(() => new FridayCliError({ argument: arguments_.join(' ') })),
  )
  return { type: 'platform-invocation-set' as const, connectionId, channelId, mode }
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
  if (arguments_.length === 2 && arguments_[0] === 'config' && arguments_[1] === 'reload') {
    return Effect.succeed({ type: 'config-reload' })
  }
  if (arguments_[0] === 'worktree' && arguments_[1] === 'ensure') {
    return parseWorktreeEnsure(arguments_)
  }
  if (arguments_[0] === 'platform' && arguments_[1] === 'invocation' && arguments_[2] === 'set') {
    return parsePlatformInvocationSet(arguments_)
  }
  if (arguments_[0] === 'platform' && arguments_[1] === 'activity-description') {
    return parsePlatformActivityDescription(arguments_)
  }
  if (arguments_[0] === 'platform' && arguments_[1] === 'system-channel') {
    return parsePlatformSystemChannel(arguments_)
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

export const runFridayCli = <
  E,
  WorktreeError,
  CleanupError,
  InvocationError,
  ActivityDescriptionError,
  SystemChannelError,
  ReloadError,
>(
  arguments_: ReadonlyArray<string>,
  options: {
    readonly start: Effect.Effect<never, E>
    readonly reloadConfig: Effect.Effect<ConfigReloadOutcomeType, ReloadError>
    readonly ensureWorktree: (
      action: Extract<FridayCliAction, { readonly type: 'worktree-ensure' }>,
    ) => Effect.Effect<ManagedWorktree, WorktreeError>
    readonly setPlatformInvocation: (
      action: Extract<FridayCliAction, { readonly type: 'platform-invocation-set' }>,
    ) => Effect.Effect<void, InvocationError>
    readonly setDiscordActivityDescription: (
      action: Extract<
        FridayCliAction,
        {
          readonly type: 'platform-activity-description-set' | 'platform-activity-description-reset'
        }
      >,
      enabled: boolean,
    ) => Effect.Effect<void, ActivityDescriptionError>
    readonly setPlatformSystemChannel: (
      action: Extract<
        FridayCliAction,
        { readonly type: 'platform-system-channel-set' | 'platform-system-channel-reset' }
      >,
      enabled: boolean,
    ) => Effect.Effect<void, SystemChannelError>
    readonly applyWorkspaceCleanup: (
      action: Extract<FridayCliAction, { readonly type: 'workspace-cleanup-apply' }>,
      currentWorkingDirectory: string,
    ) => Effect.Effect<WorkspaceCleanupProposal, CleanupError>
  },
): Effect.Effect<
  void,
  | FridayCliError
  | ConfigReloadRejectedError
  | E
  | WorktreeError
  | CleanupError
  | InvocationError
  | ActivityDescriptionError
  | SystemChannelError
  | ReloadError
> =>
  Effect.gen(function* () {
    const action = yield* parseFridayCli(arguments_)
    switch (action.type) {
      case 'help':
        yield* Console.log(helpText.trimEnd())
        return
      case 'version':
        yield* Console.log(FRIDAY_VERSION)
        return
      case 'config-reload': {
        const outcome = yield* options.reloadConfig
        if (!outcome.ok) {
          return yield* new ConfigReloadRejectedError({ detail: outcome.detail })
        }
        yield* Console.log(formatConfigReloadOutcome(outcome))
        return
      }
      case 'platform-invocation-set': {
        yield* options.setPlatformInvocation(action)
        yield* Console.log(
          `Invocation mode for ${action.connectionId}:${action.channelId} set to ${action.mode}.`,
        )
        return
      }
      case 'platform-activity-description-set':
      case 'platform-activity-description-reset': {
        const enabled = action.type === 'platform-activity-description-set'
        yield* options.setDiscordActivityDescription(action, enabled)
        yield* Console.log(
          enabled
            ? `Discord activity description for ${action.connectionId} enabled. The running process will publish current task activity.`
            : `Discord activity description for ${action.connectionId} disabled. Friday-owned text will be cleared.`,
        )
        return
      }
      case 'platform-system-channel-set':
      case 'platform-system-channel-reset': {
        const enabled = action.type === 'platform-system-channel-set'
        yield* options.setPlatformSystemChannel(action, enabled)
        yield* Console.log(
          `System channel ${action.connectionId}:${action.channelId} ${enabled ? 'configured' : 'removed'}.`,
        )
        return
      }
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
