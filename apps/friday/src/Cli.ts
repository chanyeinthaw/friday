import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { PlatformConnectionId } from '@friday/contracts/conversation'

import {
  type AccessPolicy,
  type DiscordGuildChannelConfig,
  type DiscordGuildConfig,
  InvocationMode,
  type InvocationMode as InvocationModeType,
} from './config/AppConfig.ts'
import {
  DiscordGuildChannelId,
  DiscordGuildId,
  DiscordSnowflake,
  type DiscordGuildChannelPatch,
  type DiscordGuildChannelResetOutcome,
  type DiscordGuildChannelUpdateOutcome,
  type DiscordGuildDisableOutcome,
  type DiscordGuildEnableOutcome,
  type DiscordGuildRemoveOutcome,
  type DiscordGuildUpdateOutcome,
} from './config/DiscordGuilds.ts'
import {
  BotTokenEnvName,
  DiscordPublicKey,
  type DiscordConnectionAddOutcome,
  type DiscordConnectionDetail,
  type DiscordConnectionDisableOutcome,
  type DiscordConnectionEnableOutcome,
  type DiscordConnectionRecord,
  type DiscordConnectionRemoveOutcome,
  type DiscordConnectionUpdateOutcome,
} from './config/DiscordConnections.ts'
import {
  formatConfigReloadOutcome,
  type ConfigReloadOutcome as ConfigReloadOutcomeType,
} from './config/ConfigReload.ts'
import {
  DiscordUserId,
  type DiscordAdminAddOutcome,
  type DiscordAdminRemoveOutcome,
} from './config/DiscordAdmins.ts'
import {
  RepositoryUrl,
  type ManagedWorktree,
  type ManagedWorktreeListEntry,
} from './repositories/RepositoryWorktrees.ts'
import {
  WorkspaceCleanupProposalId,
  type WorkspaceCleanupProposal,
} from './workspaces/WorkspaceCleanup.ts'

export const FRIDAY_VERSION = '0.0.0-nightly.12'

/**
 * One node of the CLI command tree: the single typed source of command and
 * help truth. Leaves may carry usage fragments; branch nodes carry children.
 */
export interface CliCommandSpec {
  readonly name: string
  readonly summary: string
  /** Usage fragments for a leaf command; fragments continue on wrapped lines. */
  readonly arguments?: ReadonlyArray<string>
  readonly children?: ReadonlyArray<CliCommandSpec>
}

const permissionPoliciesNote = `Permission policies are "all", "allow=<id>[,<id>...]", or "deny=<id>[,<id>...]".
The default reply mode is reply-in-thread; channels already inside a
user-created thread always stay in that thread.`

/** The complete Friday CLI command tree, in help and dispatch order. */
export const cliCommandSpec: CliCommandSpec = {
  name: 'friday',
  summary: 'Friday — your personal agent.',
  children: [
    { name: 'start', summary: 'Start Friday (the default when no command is given).' },
    {
      name: 'config',
      summary: "View or change Friday's stored configuration.",
      children: [
        { name: 'reload', summary: 'Reload the running Friday configuration.' },
        {
          name: 'admin',
          summary: "Manage Friday's administrator allow-list (changes need a restart).",
          children: [
            {
              name: 'discord',
              summary: 'Manage the Discord administrator allow-list.',
              children: [
                { name: 'add', summary: 'Add a Discord administrator.', arguments: ['<user-id>'] },
                {
                  name: 'remove',
                  summary: 'Remove a Discord administrator.',
                  arguments: ['<user-id>'],
                },
                {
                  name: 'list',
                  summary: 'List configured Discord administrators.',
                  arguments: ['[--json]'],
                },
              ],
            },
          ],
        },
        {
          name: 'discord',
          summary: 'Manage Discord connections, their guilds, and live activity publication.',
          children: [
            {
              name: 'connection',
              summary: "Manage one bot connection's stored topology (changes need a restart).",
              children: [
                {
                  name: 'add',
                  summary: 'Add a Discord bot connection (needs a restart).',
                  arguments: [
                    '<connection-id> --name <name> --application-id <snowflake>',
                    '--public-key <64-hex-digits> --bot-token-env <env-name>',
                    '[--respond-to-global-mentions]',
                  ],
                },
                {
                  name: 'update',
                  summary:
                    'Update stored connection fields, preserving the rest (changes need a restart).',
                  arguments: [
                    '<connection-id> [--name <name>] [--application-id <snowflake>]',
                    '[--public-key <64-hex-digits>] [--bot-token-env <env-name>]',
                    '[--respond-to-global-mentions|--no-respond-to-global-mentions]',
                  ],
                },
                {
                  name: 'remove',
                  summary: 'Remove a connection and its Discord configuration (needs a restart).',
                  arguments: ['<connection-id> --yes'],
                },
                {
                  name: 'enable',
                  summary: 'Enable a configured connection (needs a restart).',
                  arguments: ['<connection-id>'],
                },
                {
                  name: 'disable',
                  summary: 'Disable a configured connection (needs a restart).',
                  arguments: ['<connection-id>'],
                },
                {
                  name: 'get',
                  summary: "Show one connection's stored configuration.",
                  arguments: ['<connection-id> [--json]'],
                },
                {
                  name: 'list',
                  summary: 'List configured Discord connections.',
                  arguments: ['[--json]'],
                },
              ],
            },
            {
              name: 'guild',
              summary: 'Manage guild configuration (applies on the next configuration reload).',
              children: [
                {
                  name: 'enable',
                  summary: 'Enable Friday in a guild.',
                  arguments: ['<connection-id> <guild-id>'],
                },
                {
                  name: 'disable',
                  summary: 'Disable Friday in a guild.',
                  arguments: ['<connection-id> <guild-id>'],
                },
                {
                  name: 'remove',
                  summary: "Remove a guild's configuration and its channel overrides.",
                  arguments: ['<connection-id> <guild-id> --yes'],
                },
                {
                  name: 'list',
                  summary: "List a connection's guild configuration.",
                  arguments: ['<connection-id> [--json]'],
                },
                {
                  name: 'set-invocation',
                  summary: 'Set the guild-wide invocation default.',
                  arguments: ['<connection-id> <guild-id> <mention-only|all-messages>'],
                },
                {
                  name: 'set-users',
                  summary: 'Set the guild-wide user permission default.',
                  arguments: ['<connection-id> <guild-id> <all|allow=<id>[,...]|deny=<id>[,...]>'],
                },
                {
                  name: 'channel',
                  summary: 'Override guild defaults for a single channel.',
                  children: [
                    {
                      name: 'set',
                      summary: 'Set channel overrides; only the given flags change.',
                      arguments: [
                        '<connection-id> <guild-id> <channel-id>',
                        '[--invocation <mention-only|all-messages>] [--users <policy>]',
                        '[--reply-in-thread|--reply-in-channel]',
                      ],
                    },
                    {
                      name: 'reset',
                      summary: 'Remove channel overrides; guild defaults apply again.',
                      arguments: ['<connection-id> <guild-id> <channel-id>'],
                    },
                  ],
                },
              ],
            },
            {
              name: 'activity-description',
              summary:
                'Publish current task activity publicly; the running process watches this live.',
              children: [
                {
                  name: 'set',
                  summary: 'Enable public activity description for a connection now.',
                  arguments: ['<connection-id>'],
                },
                {
                  name: 'reset',
                  summary: 'Disable it and clear Friday-owned description text now.',
                  arguments: ['<connection-id>'],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'worktree',
      summary: "Manage repository worktrees registered with Friday's repository caches.",
      children: [
        {
          name: 'ensure',
          summary: 'Ensure a reusable repository worktree for the current channel workspace.',
          arguments: ['<repository-url> [--ref <ref>] [--workspace <path>] [--json]'],
        },
        {
          name: 'list',
          summary: "List repository worktrees registered with Friday's repository caches.",
          arguments: ['[--json]'],
        },
      ],
    },
    {
      name: 'workspace',
      summary: 'Manage channel workspaces and their cleanup proposals.',
      children: [
        {
          name: 'cleanup',
          summary: 'Apply or inspect workspace cleanup proposals.',
          children: [
            {
              name: 'apply',
              summary: 'Apply an approved workspace cleanup proposal.',
              arguments: ['<proposal-id> [--json]'],
            },
            {
              name: 'list',
              summary: 'List recorded workspace cleanup proposals.',
              arguments: ['[--json]'],
            },
          ],
        },
      ],
    },
  ],
}

const findCommandSpec = (path: ReadonlyArray<string>): CliCommandSpec | undefined => {
  let node: CliCommandSpec | undefined = cliCommandSpec
  for (const name of path) {
    node = node?.children?.find((child) => child.name === name)
    if (node === undefined) return undefined
  }
  return node
}

/** Resolves the deepest command prefix of the arguments as the help topic. */
const helpTopic = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const topic: string[] = []
  let node = cliCommandSpec
  for (const argument of arguments_) {
    const child = node.children?.find((candidate) => candidate.name === argument)
    if (child === undefined) break
    topic.push(child.name)
    node = child
  }
  return topic
}

const renderEntry = (path: ReadonlyArray<string>, leaf: CliCommandSpec): ReadonlyArray<string> => [
  `  ${path.join(' ')}${leaf.arguments?.[0] === undefined ? '' : ` ${leaf.arguments[0]}`}`,
  ...(leaf.arguments ?? []).slice(1).map((line) => `      ${line}`),
  `      ${leaf.summary}`,
]

const renderLeafEntries = (
  node: CliCommandSpec,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  (node.children ?? []).flatMap((child): ReadonlyArray<string> => {
    const childPath = [...path, child.name]
    return child.children === undefined
      ? renderEntry(childPath, child)
      : renderLeafEntries(child, childPath)
  })

const renderChildEntries = (node: CliCommandSpec): ReadonlyArray<string> =>
  (node.children ?? []).flatMap((child): ReadonlyArray<string> =>
    child.children === undefined
      ? renderEntry([child.name], child)
      : [`  ${child.name}`, `      ${child.summary}`],
  )

/**
 * Renders help for one command topic: the full command listing for the empty
 * topic, child commands for a branch, or the exact usage for a leaf.
 */
export const renderCliHelp = (topic: ReadonlyArray<string> = []): string => {
  const node = findCommandSpec(topic)
  if (node === undefined) return renderCliHelp([])
  if (topic.length === 0) {
    return [
      'Friday — your personal agent',
      '',
      'Usage:',
      '  friday [command]',
      '',
      'Commands:',
      ...renderLeafEntries(cliCommandSpec, []),
      '',
      'Notes:',
      ...permissionPoliciesNote.split('\n').map((line) => `  ${line}`),
      '',
      'Options:',
      '  -h, --help     Show help; add a command prefix for help on that command',
      '  -v, --version  Show the version',
    ].join('\n')
  }
  if (node.children === undefined) {
    return [
      node.summary,
      '',
      'Usage:',
      `  friday ${topic.join(' ')}${node.arguments?.[0] === undefined ? '' : ` ${node.arguments[0]}`}`,
      ...(node.arguments ?? []).slice(1).map((line) => `      ${line}`),
    ].join('\n')
  }
  return [node.summary, '', 'Commands:', ...renderChildEntries(node)].join('\n')
}

export type FridayCliAction =
  | { readonly type: 'help'; readonly topic: ReadonlyArray<string> }
  | { readonly type: 'start' }
  | { readonly type: 'version' }
  | { readonly type: 'config-reload' }
  | {
      readonly type: 'config-admin-discord-add' | 'config-admin-discord-remove'
      readonly userId: typeof DiscordUserId.Type
    }
  | { readonly type: 'config-admin-discord-list'; readonly json: boolean }
  | { readonly type: 'config-discord-connection-list'; readonly json: boolean }
  | {
      readonly type: 'config-discord-connection-add'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly name: string
      readonly applicationId: typeof DiscordSnowflake.Type
      readonly publicKey: typeof DiscordPublicKey.Type
      readonly botTokenEnv: typeof BotTokenEnvName.Type
      readonly respondToGlobalMentions: boolean
    }
  | {
      readonly type: 'config-discord-connection-update'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly name?: string
      readonly applicationId?: typeof DiscordSnowflake.Type
      readonly publicKey?: typeof DiscordPublicKey.Type
      readonly botTokenEnv?: typeof BotTokenEnvName.Type
      readonly respondToGlobalMentions?: boolean
    }
  | {
      readonly type: 'config-discord-connection-remove'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly yes: boolean
    }
  | {
      readonly type: 'config-discord-connection-enable' | 'config-discord-connection-disable'
      readonly connectionId: typeof PlatformConnectionId.Type
    }
  | {
      readonly type: 'config-discord-connection-get'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly json: boolean
    }
  | {
      readonly type: 'config-discord-guild-enable' | 'config-discord-guild-disable'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly guildId: typeof DiscordGuildId.Type
    }
  | {
      readonly type: 'config-discord-guild-remove'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly guildId: typeof DiscordGuildId.Type
      readonly yes: boolean
    }
  | {
      readonly type: 'config-discord-guild-list'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly json: boolean
    }
  | {
      readonly type: 'config-discord-guild-set-invocation'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly guildId: typeof DiscordGuildId.Type
      readonly mode: InvocationModeType
    }
  | {
      readonly type: 'config-discord-guild-set-users'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly guildId: typeof DiscordGuildId.Type
      readonly policy: AccessPolicy
    }
  | {
      readonly type: 'config-discord-guild-channel-set'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly guildId: typeof DiscordGuildId.Type
      readonly channelId: typeof DiscordGuildChannelId.Type
      readonly patch: DiscordGuildChannelPatch
    }
  | {
      readonly type: 'config-discord-guild-channel-reset'
      readonly connectionId: typeof PlatformConnectionId.Type
      readonly guildId: typeof DiscordGuildId.Type
      readonly channelId: typeof DiscordGuildChannelId.Type
    }
  | {
      readonly type:
        | 'config-discord-activity-description-set'
        | 'config-discord-activity-description-reset'
      readonly connectionId: typeof PlatformConnectionId.Type
    }
  | {
      readonly type: 'workspace-cleanup-apply'
      readonly proposalId: WorkspaceCleanupProposalId
      readonly json: boolean
    }
  | { readonly type: 'workspace-cleanup-list'; readonly json: boolean }
  | {
      readonly type: 'worktree-ensure'
      readonly url: RepositoryUrl
      readonly workspace?: string
      readonly ref?: string
      readonly json: boolean
    }
  | { readonly type: 'worktree-list'; readonly json: boolean }

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
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.detail ?? `Unknown or invalid Friday command: ${this.argument}`
  }
}

const decodeRepositoryUrl = Schema.decodeUnknownEffect(RepositoryUrl)
const decodeWorkspaceCleanupProposalId = Schema.decodeUnknownEffect(WorkspaceCleanupProposalId)
const decodePlatformConnectionId = Schema.decodeUnknownEffect(PlatformConnectionId)
const decodeInvocationMode = Schema.decodeUnknownEffect(InvocationMode)
const decodeDiscordUserId = Schema.decodeUnknownEffect(DiscordUserId)
const decodeDiscordGuildId = Schema.decodeUnknownEffect(DiscordGuildId)
const decodeDiscordGuildChannelId = Schema.decodeUnknownEffect(DiscordGuildChannelId)
const decodeDiscordSnowflake = Schema.decodeUnknownEffect(DiscordSnowflake)

/**
 * Parses a permission policy argument: `all`, `allow=<id>[,<id>...]`, or
 * `deny=<id>[,<id>...]`. Every id must be a Discord snowflake.
 */
export const parseAccessPolicySpec = (spec: string): Effect.Effect<AccessPolicy, FridayCliError> =>
  Effect.gen(function* () {
    if (spec === 'all') return { mode: 'all', ids: [] }
    const match = /^(allow|deny)=(.*)$/.exec(spec)
    if (match === null || match[2] === undefined || match[2] === '') {
      return yield* new FridayCliError({ argument: spec })
    }
    const ids = yield* Effect.forEach(match[2].split(','), (id) =>
      decodeDiscordSnowflake(id.trim()).pipe(
        Effect.mapError(() => new FridayCliError({ argument: spec })),
      ),
    )
    // SAFETY: the regex above only matches the 'allow' or 'deny' alternatives.
    return { mode: match[1] as 'allow' | 'deny', ids: [...ids] }
  })

const discordArgumentsError = (arguments_: ReadonlyArray<string>) =>
  new FridayCliError({ argument: arguments_.join(' ') })

/** A typed rejection explaining the removal of a command form. */
const removedCommandError = (
  arguments_: ReadonlyArray<string>,
  removed: string,
  replacement: string,
) =>
  new FridayCliError({
    argument: arguments_.join(' '),
    detail: `The '${removed}' command was removed; use '${replacement}' instead.`,
  })

/** A typed rejection naming the known subcommands at a command prefix. */
const unknownSubcommandError = (path: ReadonlyArray<string>, arguments_: ReadonlyArray<string>) => {
  // Every call site passes a branch node, so the child list is always present.
  const known = findCommandSpec(path)
    ?.children?.map((child) => child.name)
    .join(', ')
  return new FridayCliError({
    argument: arguments_.join(' '),
    detail: `Unknown 'friday ${path.join(' ')}' subcommand '${arguments_[path.length] ?? ''}'. Known subcommands: ${known}.`,
  })
}

const parseWorktreeEnsure = Effect.fn('Cli.parseWorktreeEnsure')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const urlArgument = arguments_[2]
  if (!urlArgument || urlArgument.startsWith('-')) {
    return yield* discordArgumentsError(arguments_)
  }
  const url = yield* decodeRepositoryUrl(urlArgument).pipe(
    Effect.mapError(() => discordArgumentsError(arguments_)),
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
        return yield* discordArgumentsError(arguments_)
      }
      if (argument === '--workspace') workspace = value
      else ref = value
      index += 1
      continue
    }
    return yield* discordArgumentsError(arguments_)
  }
  if (workspace !== undefined && ref !== undefined) {
    return { type: 'worktree-ensure' as const, url, workspace, ref, json }
  }
  if (workspace !== undefined) return { type: 'worktree-ensure' as const, url, workspace, json }
  if (ref !== undefined) return { type: 'worktree-ensure' as const, url, ref, json }
  return { type: 'worktree-ensure' as const, url, json }
})

const parseWorktreeList = Effect.fn('Cli.parseWorktreeList')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const trailing = arguments_.slice(2)
  if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '--json')) {
    return yield* discordArgumentsError(arguments_)
  }
  return { type: 'worktree-list' as const, json: trailing[0] === '--json' }
})

const parseWorkspaceCleanupApply = Effect.fn('Cli.parseWorkspaceCleanupApply')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const proposalArgument = arguments_[3]
  if (!proposalArgument || proposalArgument.startsWith('-')) {
    return yield* discordArgumentsError(arguments_)
  }
  const proposalId = yield* decodeWorkspaceCleanupProposalId(proposalArgument).pipe(
    Effect.mapError(() => discordArgumentsError(arguments_)),
  )
  const trailing = arguments_.slice(4)
  if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '--json')) {
    return yield* discordArgumentsError(arguments_)
  }
  return { type: 'workspace-cleanup-apply' as const, proposalId, json: trailing[0] === '--json' }
})

const parseWorkspaceCleanupList = Effect.fn('Cli.parseWorkspaceCleanupList')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const trailing = arguments_.slice(3)
  if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '--json')) {
    return yield* discordArgumentsError(arguments_)
  }
  return { type: 'workspace-cleanup-list' as const, json: trailing[0] === '--json' }
})

const parseConfigAdminDiscord = Effect.fn('Cli.parseConfigAdminDiscord')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const operation = arguments_[3]
  if (operation === 'add' || operation === 'remove') {
    const userIdArgument = arguments_[4]
    if (arguments_.length !== 5 || !userIdArgument) {
      return yield* discordArgumentsError(arguments_)
    }
    const userId = yield* decodeDiscordUserId(userIdArgument).pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    return operation === 'add'
      ? { type: 'config-admin-discord-add' as const, userId }
      : { type: 'config-admin-discord-remove' as const, userId }
  }
  if (operation === 'list') {
    const trailing = arguments_.slice(4)
    if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '--json')) {
      return yield* discordArgumentsError(arguments_)
    }
    return { type: 'config-admin-discord-list' as const, json: trailing[0] === '--json' }
  }
  return yield* unknownSubcommandError(['config', 'admin', 'discord'], arguments_)
})

const parseConfigDiscordActivityDescription = Effect.fn(
  'Cli.parseConfigDiscordActivityDescription',
)(function* (arguments_: ReadonlyArray<string>) {
  const operation = arguments_[3]
  if (arguments_.length !== 5 || (operation !== 'set' && operation !== 'reset')) {
    return yield* discordArgumentsError(arguments_)
  }
  const connectionId = yield* decodePlatformConnectionId(arguments_[4] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(arguments_)),
  )
  return {
    type: `config-discord-activity-description-${operation}` as const,
    connectionId,
  }
})

const parseConfigDiscordConnection = Effect.fn('Cli.parseConfigDiscordConnection')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const operation = arguments_[3]
  if (operation === 'list') {
    const trailing = arguments_.slice(4)
    if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '--json')) {
      return yield* discordArgumentsError(arguments_)
    }
    return { type: 'config-discord-connection-list' as const, json: trailing[0] === '--json' }
  }
  if (operation === 'add') return yield* parseConfigDiscordConnectionAdd(arguments_)
  if (operation === 'update') return yield* parseConfigDiscordConnectionUpdate(arguments_)
  if (operation === 'remove') return yield* parseConfigDiscordConnectionRemove(arguments_)
  if (operation === 'enable' || operation === 'disable') {
    if (arguments_.length !== 5) return yield* discordArgumentsError(arguments_)
    const connectionId = yield* decodePlatformConnectionId(arguments_[4] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    return {
      type: `config-discord-connection-${operation}` as const,
      connectionId,
    }
  }
  if (operation === 'get') {
    if (arguments_.length < 5 || arguments_.length > 6) {
      return yield* discordArgumentsError(arguments_)
    }
    const connectionId = yield* decodePlatformConnectionId(arguments_[4] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    const trailing = arguments_.slice(5)
    if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '--json')) {
      return yield* discordArgumentsError(arguments_)
    }
    return {
      type: 'config-discord-connection-get' as const,
      connectionId,
      json: trailing[0] === '--json',
    }
  }
  return yield* unknownSubcommandError(['config', 'discord', 'connection'], arguments_)
})

/** Rejects missing and flag-like values before a command-specific decoder runs. */
const connectionFlagValue = (
  value: string | undefined,
  arguments_: ReadonlyArray<string>,
): Effect.Effect<string, FridayCliError> =>
  value === undefined || value.startsWith('-')
    ? Effect.fail(discordArgumentsError(arguments_))
    : Effect.succeed(value)

const decodeConnectionName = Schema.decodeUnknownEffect(
  Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
)
const decodeDiscordPublicKey = Schema.decodeUnknownEffect(DiscordPublicKey)
const decodeBotTokenEnvName = Schema.decodeUnknownEffect(BotTokenEnvName)

const missingUpdateFieldError = (arguments_: ReadonlyArray<string>) =>
  new FridayCliError({
    argument: arguments_.join(' '),
    detail:
      'Provide at least one field to update: --name, --application-id, --public-key, --bot-token-env, --respond-to-global-mentions, or --no-respond-to-global-mentions.',
  })

/** Mutable assembly shape for the connection update parsed from CLI flags. */
interface ParsedDiscordConnectionUpdate {
  type: 'config-discord-connection-update'
  connectionId: typeof PlatformConnectionId.Type
  name?: string
  applicationId?: typeof DiscordSnowflake.Type
  publicKey?: typeof DiscordPublicKey.Type
  botTokenEnv?: typeof BotTokenEnvName.Type
  respondToGlobalMentions?: boolean
}

const parseConfigDiscordConnectionUpdate = Effect.fn('Cli.parseConfigDiscordConnectionUpdate')(
  function* (arguments_: ReadonlyArray<string>) {
    if (arguments_.length < 5) return yield* missingUpdateFieldError(arguments_)
    const connectionArgument = yield* positionalArgument(arguments_, 4).pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    const connectionId = yield* decodePlatformConnectionId(connectionArgument).pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    let name: string | undefined
    let applicationId: typeof DiscordSnowflake.Type | undefined
    let publicKey: typeof DiscordPublicKey.Type | undefined
    let botTokenEnv: typeof BotTokenEnvName.Type | undefined
    let respondToGlobalMentions: boolean | undefined
    let index = 5
    while (index < arguments_.length) {
      const flag = arguments_[index]
      if (flag === '--respond-to-global-mentions') {
        if (respondToGlobalMentions !== undefined) return yield* discordArgumentsError(arguments_)
        respondToGlobalMentions = true
        index += 1
        continue
      }
      if (flag === '--no-respond-to-global-mentions') {
        if (respondToGlobalMentions !== undefined) return yield* discordArgumentsError(arguments_)
        respondToGlobalMentions = false
        index += 1
        continue
      }
      const value = arguments_[index + 1]
      if (flag === '--name') {
        if (name !== undefined) return yield* discordArgumentsError(arguments_)
        name = yield* connectionFlagValue(value, arguments_).pipe(
          Effect.flatMap(decodeConnectionName),
          Effect.mapError(() => discordArgumentsError(arguments_)),
        )
        index += 2
        continue
      }
      if (flag === '--application-id') {
        if (applicationId !== undefined) return yield* discordArgumentsError(arguments_)
        applicationId = yield* connectionFlagValue(value, arguments_).pipe(
          Effect.flatMap(decodeDiscordSnowflake),
          Effect.mapError(() => discordArgumentsError(arguments_)),
        )
        index += 2
        continue
      }
      if (flag === '--public-key') {
        if (publicKey !== undefined) return yield* discordArgumentsError(arguments_)
        publicKey = yield* connectionFlagValue(value, arguments_).pipe(
          Effect.flatMap(decodeDiscordPublicKey),
          Effect.mapError(() => discordArgumentsError(arguments_)),
        )
        index += 2
        continue
      }
      if (flag === '--bot-token-env') {
        if (botTokenEnv !== undefined) return yield* discordArgumentsError(arguments_)
        botTokenEnv = yield* connectionFlagValue(value, arguments_).pipe(
          Effect.flatMap(decodeBotTokenEnvName),
          Effect.mapError(() => discordArgumentsError(arguments_)),
        )
        index += 2
        continue
      }
      return yield* discordArgumentsError(arguments_)
    }
    if (
      name === undefined &&
      applicationId === undefined &&
      publicKey === undefined &&
      botTokenEnv === undefined &&
      respondToGlobalMentions === undefined
    ) {
      return yield* missingUpdateFieldError(arguments_)
    }
    // Mutable assembly shape: exactOptionalPropertyTypes allows assigning a
    // property only when the flag was present on the command line.
    const action: ParsedDiscordConnectionUpdate = {
      type: 'config-discord-connection-update',
      connectionId,
    }
    if (name !== undefined) action.name = name
    if (applicationId !== undefined) action.applicationId = applicationId
    if (publicKey !== undefined) action.publicKey = publicKey
    if (botTokenEnv !== undefined) action.botTokenEnv = botTokenEnv
    if (respondToGlobalMentions !== undefined) {
      action.respondToGlobalMentions = respondToGlobalMentions
    }
    return action
  },
)

const parseConfigDiscordConnectionAdd = Effect.fn('Cli.parseConfigDiscordConnectionAdd')(function* (
  arguments_: ReadonlyArray<string>,
) {
  if (arguments_.length < 10) return yield* discordArgumentsError(arguments_)
  const connectionId = yield* decodePlatformConnectionId(arguments_[4] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(arguments_)),
  )
  let name: string | undefined
  let applicationId: typeof DiscordSnowflake.Type | undefined
  let publicKey: typeof DiscordPublicKey.Type | undefined
  let botTokenEnv: typeof BotTokenEnvName.Type | undefined
  let respondToGlobalMentions = false
  let index = 5
  while (index < arguments_.length) {
    const flag = arguments_[index]
    if (flag === '--respond-to-global-mentions') {
      respondToGlobalMentions = true
      index += 1
      continue
    }
    const value = arguments_[index + 1]
    if (flag === '--name') {
      if (name !== undefined) return yield* discordArgumentsError(arguments_)
      name = yield* connectionFlagValue(value, arguments_).pipe(
        Effect.flatMap(decodeConnectionName),
        Effect.mapError(() => discordArgumentsError(arguments_)),
      )
      index += 2
      continue
    }
    if (flag === '--application-id') {
      if (applicationId !== undefined) return yield* discordArgumentsError(arguments_)
      applicationId = yield* connectionFlagValue(value, arguments_).pipe(
        Effect.flatMap(decodeDiscordSnowflake),
        Effect.mapError(() => discordArgumentsError(arguments_)),
      )
      index += 2
      continue
    }
    if (flag === '--public-key') {
      if (publicKey !== undefined) return yield* discordArgumentsError(arguments_)
      publicKey = yield* connectionFlagValue(value, arguments_).pipe(
        Effect.flatMap(decodeDiscordPublicKey),
        Effect.mapError(() => discordArgumentsError(arguments_)),
      )
      index += 2
      continue
    }
    if (flag === '--bot-token-env') {
      if (botTokenEnv !== undefined) return yield* discordArgumentsError(arguments_)
      botTokenEnv = yield* connectionFlagValue(value, arguments_).pipe(
        Effect.flatMap(decodeBotTokenEnvName),
        Effect.mapError(() => discordArgumentsError(arguments_)),
      )
      index += 2
      continue
    }
    return yield* discordArgumentsError(arguments_)
  }
  if (
    name === undefined ||
    applicationId === undefined ||
    publicKey === undefined ||
    botTokenEnv === undefined
  ) {
    return yield* discordArgumentsError(arguments_)
  }
  return {
    type: 'config-discord-connection-add' as const,
    connectionId,
    name,
    applicationId,
    publicKey,
    botTokenEnv,
    respondToGlobalMentions,
  }
})

const parseConfigDiscordConnectionRemove = Effect.fn('Cli.parseConfigDiscordConnectionRemove')(
  function* (arguments_: ReadonlyArray<string>) {
    if (arguments_.length !== 6 || arguments_[5] !== '--yes') {
      return yield* discordArgumentsError(arguments_)
    }
    const connectionId = yield* decodePlatformConnectionId(arguments_[4] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    return {
      type: 'config-discord-connection-remove' as const,
      connectionId,
      yes: true,
    }
  },
)

/** Parses one required positional argument, rejecting flags and missing values. */
const positionalArgument = (
  arguments_: ReadonlyArray<string>,
  index: number,
): Effect.Effect<string, FridayCliError> => {
  const argument = arguments_[index]
  return argument === undefined || argument.startsWith('-')
    ? Effect.fail(discordArgumentsError(arguments_))
    : Effect.succeed(argument)
}

const parseConnectionGuild = Effect.fn('Cli.parseConnectionGuild')(function* (
  arguments_: ReadonlyArray<string>,
  connectionIndex: number,
  guildIndex: number,
) {
  const connectionArgument = yield* positionalArgument(arguments_, connectionIndex)
  const guildArgument = yield* positionalArgument(arguments_, guildIndex)
  const connectionId = yield* decodePlatformConnectionId(connectionArgument).pipe(
    Effect.mapError(() => discordArgumentsError(arguments_)),
  )
  const guildId = yield* decodeDiscordGuildId(guildArgument).pipe(
    Effect.mapError(() => discordArgumentsError(arguments_)),
  )
  return { connectionId, guildId }
})

const guildRemoveConfirmationError = (arguments_: ReadonlyArray<string>) =>
  new FridayCliError({
    argument: arguments_.join(' '),
    detail:
      "Guild removal also deletes the guild's channel overrides; re-run with --yes to confirm.",
  })

const parseConfigDiscordGuild = Effect.fn('Cli.parseConfigDiscordGuild')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const operation = arguments_[3]
  if (operation === 'enable' || operation === 'disable') {
    if (arguments_.length !== 6) return yield* discordArgumentsError(arguments_)
    const { connectionId, guildId } = yield* parseConnectionGuild(arguments_, 4, 5)
    return {
      type: `config-discord-guild-${operation}` as const,
      connectionId,
      guildId,
    }
  }
  if (operation === 'remove') {
    if (arguments_.length === 6) return yield* guildRemoveConfirmationError(arguments_)
    if (arguments_.length !== 7 || arguments_[6] !== '--yes') {
      return yield* discordArgumentsError(arguments_)
    }
    const { connectionId, guildId } = yield* parseConnectionGuild(arguments_, 4, 5)
    return { type: 'config-discord-guild-remove' as const, connectionId, guildId, yes: true }
  }
  if (operation === 'list') {
    if (arguments_.length < 5 || arguments_.length > 6) {
      return yield* discordArgumentsError(arguments_)
    }
    const connectionArgument = yield* positionalArgument(arguments_, 4)
    const connectionId = yield* decodePlatformConnectionId(connectionArgument).pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    const trailing = arguments_.slice(5)
    if (trailing.length > 1 || (trailing.length === 1 && trailing[0] !== '--json')) {
      return yield* discordArgumentsError(arguments_)
    }
    return {
      type: 'config-discord-guild-list' as const,
      connectionId,
      json: trailing[0] === '--json',
    }
  }
  if (operation === 'set-invocation') {
    if (arguments_.length !== 7) return yield* discordArgumentsError(arguments_)
    const { connectionId, guildId } = yield* parseConnectionGuild(arguments_, 4, 5)
    const mode = yield* decodeInvocationMode(arguments_[6] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    return {
      type: 'config-discord-guild-set-invocation' as const,
      connectionId,
      guildId,
      mode,
    }
  }
  if (operation === 'set-users') {
    if (arguments_.length !== 7) return yield* discordArgumentsError(arguments_)
    const { connectionId, guildId } = yield* parseConnectionGuild(arguments_, 4, 5)
    const policy = yield* parseAccessPolicySpec(arguments_[6] ?? '')
    return {
      type: 'config-discord-guild-set-users' as const,
      connectionId,
      guildId,
      policy,
    }
  }
  if (operation === 'invocation') {
    return yield* removedCommandError(
      arguments_,
      'config discord guild invocation set',
      'friday config discord guild set-invocation <connection-id> <guild-id> <mode>',
    )
  }
  if (operation === 'users') {
    return yield* removedCommandError(
      arguments_,
      'config discord guild users set',
      'friday config discord guild set-users <connection-id> <guild-id> <policy>',
    )
  }
  if (operation === 'channel') {
    return yield* parseConfigDiscordGuildChannel(arguments_)
  }
  return yield* unknownSubcommandError(['config', 'discord', 'guild'], arguments_)
})

/** Mutable assembly shape for the channel patch parsed from CLI flags. */
interface ParsedDiscordGuildChannelPatch {
  invocationMode?: InvocationModeType
  users?: AccessPolicy
  replyMode?: 'reply-in-thread' | 'reply-in-channel'
}

/** Builds a channel patch carrying only the overrides present on the command line. */
const buildChannelPatch = (
  invocationMode: InvocationModeType | undefined,
  users: AccessPolicy | undefined,
  replyMode: 'reply-in-thread' | 'reply-in-channel' | undefined,
): DiscordGuildChannelPatch => {
  const patch: ParsedDiscordGuildChannelPatch = {}
  if (invocationMode !== undefined) patch.invocationMode = invocationMode
  if (users !== undefined) patch.users = users
  if (replyMode !== undefined) patch.replyMode = replyMode
  return patch
}

const parseConfigDiscordGuildChannel = Effect.fn('Cli.parseConfigDiscordGuildChannel')(function* (
  arguments_: ReadonlyArray<string>,
) {
  const operation = arguments_[4]
  if (operation === 'reset') {
    if (arguments_.length !== 8) return yield* discordArgumentsError(arguments_)
    const { connectionId, guildId } = yield* parseConnectionGuild(arguments_, 5, 6)
    const channelId = yield* decodeDiscordGuildChannelId(arguments_[7] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(arguments_)),
    )
    return {
      type: 'config-discord-guild-channel-reset' as const,
      connectionId,
      guildId,
      channelId,
    }
  }
  if (operation !== 'set') return yield* discordArgumentsError(arguments_)
  if (arguments_.length < 8) return yield* discordArgumentsError(arguments_)
  const { connectionId, guildId } = yield* parseConnectionGuild(arguments_, 5, 6)
  const channelArgument = yield* positionalArgument(arguments_, 7)
  const channelId = yield* decodeDiscordGuildChannelId(channelArgument).pipe(
    Effect.mapError(() => discordArgumentsError(arguments_)),
  )
  let invocationMode: InvocationModeType | undefined
  let users: AccessPolicy | undefined
  let replyMode: 'reply-in-thread' | 'reply-in-channel' | undefined
  let index = 8
  while (index < arguments_.length) {
    const flag = arguments_[index]
    if (flag === '--reply-in-thread' || flag === '--reply-in-channel') {
      if (replyMode !== undefined) return yield* discordArgumentsError(arguments_)
      replyMode = flag === '--reply-in-thread' ? 'reply-in-thread' : 'reply-in-channel'
      index += 1
      continue
    }
    const value = arguments_[index + 1]
    if (flag === '--invocation') {
      if (invocationMode !== undefined || value === undefined) {
        return yield* discordArgumentsError(arguments_)
      }
      invocationMode = yield* decodeInvocationMode(value).pipe(
        Effect.mapError(() => discordArgumentsError(arguments_)),
      )
      index += 2
      continue
    }
    if (flag === '--users') {
      if (users !== undefined || value === undefined) {
        return yield* discordArgumentsError(arguments_)
      }
      users = yield* parseAccessPolicySpec(value)
      index += 2
      continue
    }
    return yield* discordArgumentsError(arguments_)
  }
  if (invocationMode === undefined && users === undefined && replyMode === undefined) {
    // A channel set with no overrides would be a no-op row.
    return yield* discordArgumentsError(arguments_)
  }
  return {
    type: 'config-discord-guild-channel-set' as const,
    connectionId,
    guildId,
    channelId,
    patch: buildChannelPatch(invocationMode, users, replyMode),
  }
})

export const parseFridayCli = (
  arguments_: ReadonlyArray<string>,
): Effect.Effect<FridayCliAction, FridayCliError> => {
  const helpIndex = arguments_.findIndex((argument) => argument === '-h' || argument === '--help')
  if (helpIndex >= 0) {
    return Effect.succeed({ type: 'help', topic: helpTopic(arguments_.slice(0, helpIndex)) })
  }
  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === 'start')) {
    return Effect.succeed({ type: 'start' })
  }
  if (arguments_.length === 1 && (arguments_[0] === '--version' || arguments_[0] === '-v')) {
    return Effect.succeed({ type: 'version' })
  }
  if (arguments_.length === 2 && arguments_[0] === 'config' && arguments_[1] === 'reload') {
    return Effect.succeed({ type: 'config-reload' })
  }
  if (arguments_[0] === 'config' && arguments_[1] === 'admin' && arguments_[2] === 'discord') {
    return parseConfigAdminDiscord(arguments_)
  }
  if (arguments_[0] === 'config' && arguments_[1] === 'discord') {
    if (arguments_[2] === 'connection') return parseConfigDiscordConnection(arguments_)
    if (arguments_[2] === 'guild') return parseConfigDiscordGuild(arguments_)
    if (arguments_[2] === 'activity-description') {
      return parseConfigDiscordActivityDescription(arguments_)
    }
    return Effect.fail(unknownSubcommandError(['config', 'discord'], arguments_))
  }
  if (arguments_[0] === 'worktree' && arguments_[1] === 'ensure') {
    return parseWorktreeEnsure(arguments_)
  }
  if (arguments_[0] === 'worktree' && arguments_[1] === 'list') {
    return parseWorktreeList(arguments_)
  }
  if (arguments_[0] === 'worktree') {
    return Effect.fail(unknownSubcommandError(['worktree'], arguments_))
  }
  if (arguments_[0] === 'platform' && arguments_[1] === 'activity-description') {
    return Effect.fail(
      removedCommandError(
        arguments_,
        'platform activity-description set|reset',
        'friday config discord activity-description set|reset <connection-id>',
      ),
    )
  }
  if (arguments_[0] === 'workspace' && arguments_[1] === 'cleanup') {
    if (arguments_[2] === 'apply') return parseWorkspaceCleanupApply(arguments_)
    if (arguments_[2] === 'list') return parseWorkspaceCleanupList(arguments_)
    return Effect.fail(unknownSubcommandError(['workspace', 'cleanup'], arguments_))
  }
  if (arguments_[0] === 'workspace') {
    return Effect.fail(unknownSubcommandError(['workspace'], arguments_))
  }
  return Effect.fail(discordArgumentsError(arguments_))
}

const renderCleanup = (proposal: WorkspaceCleanupProposal): string => `Workspace cleanup applied
  Proposal: ${proposal.id}
  Worktrees: ${proposal.resources.length}
  Reclaimed: ${proposal.estimatedBytes} bytes`

export const renderWorktreeList = (worktrees: ReadonlyArray<ManagedWorktreeListEntry>): string =>
  worktrees.length === 0
    ? "No repository worktrees are registered with Friday's repository caches."
    : [
        'Repository worktrees:',
        ...worktrees.flatMap((worktree) => [
          `  ${worktree.url}`,
          `    ${worktree.path}  ${worktree.branch === null ? '(detached head)' : worktree.branch}  ${worktree.head.slice(0, 12)}${worktree.prunable ? '  (missing on disk)' : ''}`,
        ]),
      ].join('\n')

export const renderWorkspaceCleanupList = (
  proposals: ReadonlyArray<WorkspaceCleanupProposal>,
): string =>
  proposals.length === 0
    ? 'No workspace cleanup proposals are recorded.'
    : [
        'Workspace cleanup proposals:',
        ...proposals.flatMap((proposal) => [
          `  ${proposal.id}  ${proposal.status}  ${proposal.summary}`,
          `    Workspace: ${proposal.workspacePath}`,
          ...proposal.resources.map(
            (resource) =>
              `    Worktree: ${resource.path} (${resource.branch}, ${resource.sizeBytes} bytes)`,
          ),
        ]),
      ].join('\n')

/** Human-readable add outcome; the restart note reflects startup-pinned admins. */
export const formatDiscordAdminAdd = (
  userId: typeof DiscordUserId.Type,
  outcome: DiscordAdminAddOutcome,
): string =>
  outcome === 'added'
    ? `Discord admin ${userId} added. Restart Friday to apply it: the admin allow-list is pinned at startup.`
    : `Discord admin ${userId} is already configured.`

/** Human-readable remove outcome; the restart note reflects startup-pinned admins. */
export const formatDiscordAdminRemove = (
  userId: typeof DiscordUserId.Type,
  outcome: DiscordAdminRemoveOutcome,
): string =>
  outcome === 'removed'
    ? `Discord admin ${userId} removed. Restart Friday to apply it: the admin allow-list is pinned at startup.`
    : `Discord admin ${userId} is not configured.`

/** Human-readable administrator list in stable sorted order. */
export const renderDiscordAdminList = (userIds: ReadonlyArray<string>): string =>
  userIds.length === 0
    ? 'No Discord administrators are configured.'
    : ['Discord administrators:', ...userIds.map((id) => `  ${id}`)].join('\n')

export const renderDiscordConnectionList = (
  connections: ReadonlyArray<DiscordConnectionRecord>,
): string =>
  connections.length === 0
    ? 'No Discord connections are configured.'
    : [
        'Discord connections:',
        ...connections.map(
          ({ connectionId, name, enabled }) =>
            `  ${connectionId}  ${enabled ? 'enabled' : 'disabled'}  ${name}`,
        ),
      ].join('\n')

export const renderDiscordConnectionDetail = (detail: DiscordConnectionDetail): string =>
  [
    `Discord connection ${detail.connectionId}:`,
    `  Name: ${detail.name}`,
    `  Enabled: ${detail.enabled ? 'yes' : 'no'}`,
    `  Application ID: ${detail.applicationId}`,
    `  Public key: ${detail.publicKey}`,
    `  Bot token env: ${detail.botTokenEnv}`,
    `  Responds to global mentions: ${detail.respondToGlobalMentions ? 'yes' : 'no'}`,
    `  Public activity description: ${detail.activityDescription ? 'yes' : 'no'}`,
  ].join('\n')

const restartNote = 'Restart Friday to apply it: connection topology is pinned at startup.'

export const formatDiscordConnectionAdd = (
  connectionId: typeof PlatformConnectionId.Type,
  outcome: DiscordConnectionAddOutcome,
): string =>
  outcome === 'added'
    ? `Discord connection ${connectionId} added. ${restartNote}`
    : outcome === 'connection-exists'
      ? `A connection named ${connectionId} already exists.`
      : 'The application ID is already used by another Discord connection.'

export const formatDiscordConnectionUpdate = (
  connectionId: typeof PlatformConnectionId.Type,
  outcome: DiscordConnectionUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Discord connection ${connectionId} updated. ${restartNote}`
    : outcome === 'unchanged'
      ? `Discord connection ${connectionId} already has the requested configuration; nothing changed.`
      : outcome === 'application-exists'
        ? 'The application ID is already used by another Discord connection.'
        : `Discord connection ${connectionId} is not configured.`

export const formatDiscordConnectionRemove = (
  connectionId: typeof PlatformConnectionId.Type,
  outcome: DiscordConnectionRemoveOutcome,
): string =>
  outcome === 'removed'
    ? `Discord connection ${connectionId} removed together with its Discord configuration. ${restartNote}`
    : `Discord connection ${connectionId} is not configured.`

export const formatDiscordConnectionEnable = (
  connectionId: typeof PlatformConnectionId.Type,
  outcome: DiscordConnectionEnableOutcome,
): string =>
  outcome === 'enabled'
    ? `Discord connection ${connectionId} enabled. ${restartNote}`
    : outcome === 'already-enabled'
      ? `Discord connection ${connectionId} is already enabled.`
      : `Discord connection ${connectionId} is not configured.`

export const formatDiscordConnectionDisable = (
  connectionId: typeof PlatformConnectionId.Type,
  outcome: DiscordConnectionDisableOutcome,
): string =>
  outcome === 'disabled'
    ? `Discord connection ${connectionId} disabled. ${restartNote}`
    : outcome === 'already-disabled'
      ? `Discord connection ${connectionId} is already disabled.`
      : `Discord connection ${connectionId} is not configured.`

const renderGuildPolicy = (policy: AccessPolicy): string =>
  policy.mode === 'all' ? 'all' : `${policy.mode}=${policy.ids.join(',')}`

const renderGuildChannel = (channel: DiscordGuildChannelConfig): string => {
  const overrides = [
    channel.invocationMode === undefined ? undefined : `invocation: ${channel.invocationMode}`,
    channel.users === undefined ? undefined : `users: ${renderGuildPolicy(channel.users)}`,
    channel.replyMode === undefined ? undefined : `reply: ${channel.replyMode}`,
  ].filter((entry) => entry !== undefined)
  return `  channel ${channel.channelId}: ${overrides.length === 0 ? '(no overrides)' : overrides.join(', ')}`
}

export const renderDiscordGuildList = (guilds: ReadonlyArray<DiscordGuildConfig>): string =>
  guilds.length === 0
    ? 'No guilds are configured for this connection.'
    : guilds
        .map((guild) =>
          [
            `guild ${guild.guildId}: ${guild.enabled ? 'enabled' : 'disabled'}, invocation: ${guild.invocation.defaultMode}${guild.users === undefined ? '' : `, users: ${renderGuildPolicy(guild.users)}`}`,
            ...guild.channels.map(renderGuildChannel),
          ].join('\n'),
        )
        .join('\n')

const reloadNote = 'The running Friday picks this up on its next configuration reload.'

export const formatDiscordGuildEnable = (
  guildId: typeof DiscordGuildId.Type,
  outcome: DiscordGuildEnableOutcome,
): string =>
  outcome === 'enabled'
    ? `Guild ${guildId} enabled. ${reloadNote}`
    : `Guild ${guildId} is already enabled.`

export const formatDiscordGuildDisable = (
  guildId: typeof DiscordGuildId.Type,
  outcome: DiscordGuildDisableOutcome,
): string =>
  outcome === 'disabled'
    ? `Guild ${guildId} disabled. ${reloadNote}`
    : outcome === 'already-disabled'
      ? `Guild ${guildId} is already disabled.`
      : `Guild ${guildId} is not configured.`

export const formatDiscordGuildRemove = (
  guildId: typeof DiscordGuildId.Type,
  outcome: DiscordGuildRemoveOutcome,
): string =>
  outcome === 'removed'
    ? `Guild ${guildId} removed together with its channel overrides. ${reloadNote}`
    : `Guild ${guildId} is not configured.`

export const formatDiscordGuildInvocation = (
  guildId: typeof DiscordGuildId.Type,
  mode: InvocationModeType,
  outcome: DiscordGuildUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Guild-wide invocation default for ${guildId} set to ${mode}. ${reloadNote}`
    : `Guild ${guildId} is not configured. Enable it first.`

export const formatDiscordGuildUsers = (
  guildId: typeof DiscordGuildId.Type,
  policy: AccessPolicy,
  outcome: DiscordGuildUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Guild-wide user permission default for ${guildId} set to ${renderGuildPolicy(policy)}. ${reloadNote}`
    : `Guild ${guildId} is not configured. Enable it first.`

export const formatDiscordGuildChannelSet = (
  channelId: typeof DiscordGuildChannelId.Type,
  outcome: DiscordGuildChannelUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Channel ${channelId} overrides updated. ${reloadNote}`
    : `The guild owning channel ${channelId} is not configured. Enable it first.`

export const formatDiscordGuildChannelReset = (
  channelId: typeof DiscordGuildChannelId.Type,
  outcome: DiscordGuildChannelResetOutcome,
): string =>
  outcome === 'removed'
    ? `Channel ${channelId} overrides removed; guild defaults apply. ${reloadNote}`
    : `No overrides are configured for channel ${channelId}.`

const activityDescriptionNote =
  'The running Friday publishes this live; the change takes effect within about a second, without a reload or restart.'

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
  ActivityDescriptionError,
  GuildError,
  ReloadError,
  AdminError,
  ConnectionError,
>(
  arguments_: ReadonlyArray<string>,
  options: {
    readonly start: Effect.Effect<never, E>
    readonly reloadConfig: Effect.Effect<ConfigReloadOutcomeType, ReloadError>
    readonly addDiscordAdmin: (
      userId: typeof DiscordUserId.Type,
    ) => Effect.Effect<DiscordAdminAddOutcome, AdminError>
    readonly removeDiscordAdmin: (
      userId: typeof DiscordUserId.Type,
    ) => Effect.Effect<DiscordAdminRemoveOutcome, AdminError>
    readonly listDiscordAdmins: () => Effect.Effect<ReadonlyArray<string>, AdminError>
    readonly addDiscordConnection: (
      input: Extract<FridayCliAction, { readonly type: 'config-discord-connection-add' }>,
    ) => Effect.Effect<DiscordConnectionAddOutcome, ConnectionError>
    readonly updateDiscordConnection: (
      action: Extract<FridayCliAction, { readonly type: 'config-discord-connection-update' }>,
    ) => Effect.Effect<DiscordConnectionUpdateOutcome, ConnectionError>
    readonly removeDiscordConnection: (
      connectionId: typeof PlatformConnectionId.Type,
    ) => Effect.Effect<DiscordConnectionRemoveOutcome, ConnectionError>
    readonly enableDiscordConnection: (
      connectionId: typeof PlatformConnectionId.Type,
    ) => Effect.Effect<DiscordConnectionEnableOutcome, ConnectionError>
    readonly disableDiscordConnection: (
      connectionId: typeof PlatformConnectionId.Type,
    ) => Effect.Effect<DiscordConnectionDisableOutcome, ConnectionError>
    readonly getDiscordConnection: (
      connectionId: typeof PlatformConnectionId.Type,
    ) => Effect.Effect<Option.Option<DiscordConnectionDetail>, ConnectionError>
    readonly listDiscordConnections: () => Effect.Effect<
      ReadonlyArray<DiscordConnectionRecord>,
      ConnectionError
    >
    readonly listDiscordGuilds: (
      connectionId: typeof PlatformConnectionId.Type,
    ) => Effect.Effect<ReadonlyArray<DiscordGuildConfig>, GuildError>
    readonly enableDiscordGuild: (
      connectionId: typeof PlatformConnectionId.Type,
      guildId: typeof DiscordGuildId.Type,
    ) => Effect.Effect<DiscordGuildEnableOutcome, GuildError>
    readonly disableDiscordGuild: (
      connectionId: typeof PlatformConnectionId.Type,
      guildId: typeof DiscordGuildId.Type,
    ) => Effect.Effect<DiscordGuildDisableOutcome, GuildError>
    readonly removeDiscordGuild: (
      connectionId: typeof PlatformConnectionId.Type,
      guildId: typeof DiscordGuildId.Type,
    ) => Effect.Effect<DiscordGuildRemoveOutcome, GuildError>
    readonly setDiscordGuildInvocation: (
      connectionId: typeof PlatformConnectionId.Type,
      guildId: typeof DiscordGuildId.Type,
      mode: InvocationModeType,
    ) => Effect.Effect<DiscordGuildUpdateOutcome, GuildError>
    readonly setDiscordGuildUsers: (
      connectionId: typeof PlatformConnectionId.Type,
      guildId: typeof DiscordGuildId.Type,
      policy: AccessPolicy,
    ) => Effect.Effect<DiscordGuildUpdateOutcome, GuildError>
    readonly setDiscordGuildChannel: (
      connectionId: typeof PlatformConnectionId.Type,
      guildId: typeof DiscordGuildId.Type,
      channelId: typeof DiscordGuildChannelId.Type,
      patch: DiscordGuildChannelPatch,
    ) => Effect.Effect<DiscordGuildChannelUpdateOutcome, GuildError>
    readonly resetDiscordGuildChannel: (
      connectionId: typeof PlatformConnectionId.Type,
      guildId: typeof DiscordGuildId.Type,
      channelId: typeof DiscordGuildChannelId.Type,
    ) => Effect.Effect<DiscordGuildChannelResetOutcome, GuildError>
    readonly ensureWorktree: (
      action: Extract<FridayCliAction, { readonly type: 'worktree-ensure' }>,
    ) => Effect.Effect<ManagedWorktree, WorktreeError>
    readonly listWorktrees: () => Effect.Effect<
      ReadonlyArray<ManagedWorktreeListEntry>,
      WorktreeError
    >
    readonly setDiscordActivityDescription: (
      action: Extract<
        FridayCliAction,
        {
          readonly type:
            | 'config-discord-activity-description-set'
            | 'config-discord-activity-description-reset'
        }
      >,
      enabled: boolean,
    ) => Effect.Effect<void, ActivityDescriptionError>
    readonly applyWorkspaceCleanup: (
      action: Extract<FridayCliAction, { readonly type: 'workspace-cleanup-apply' }>,
      currentWorkingDirectory: string,
    ) => Effect.Effect<WorkspaceCleanupProposal, CleanupError>
    readonly listWorkspaceCleanupProposals: () => Effect.Effect<
      ReadonlyArray<WorkspaceCleanupProposal>,
      CleanupError
    >
  },
): Effect.Effect<
  void,
  | FridayCliError
  | ConfigReloadRejectedError
  | E
  | WorktreeError
  | CleanupError
  | ActivityDescriptionError
  | GuildError
  | ReloadError
  | AdminError
  | ConnectionError
> =>
  Effect.gen(function* () {
    const action = yield* parseFridayCli(arguments_)
    switch (action.type) {
      case 'help':
        yield* Console.log(renderCliHelp(action.topic))
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
      case 'config-admin-discord-add': {
        const outcome = yield* options.addDiscordAdmin(action.userId)
        yield* Console.log(formatDiscordAdminAdd(action.userId, outcome))
        return
      }
      case 'config-admin-discord-remove': {
        const outcome = yield* options.removeDiscordAdmin(action.userId)
        yield* Console.log(formatDiscordAdminRemove(action.userId, outcome))
        return
      }
      case 'config-admin-discord-list': {
        const userIds = yield* options.listDiscordAdmins()
        yield* Console.log(action.json ? JSON.stringify(userIds) : renderDiscordAdminList(userIds))
        return
      }
      case 'config-discord-connection-add': {
        const outcome = yield* options.addDiscordConnection(action)
        yield* Console.log(formatDiscordConnectionAdd(action.connectionId, outcome))
        return
      }
      case 'config-discord-connection-update': {
        const outcome = yield* options.updateDiscordConnection(action)
        yield* Console.log(formatDiscordConnectionUpdate(action.connectionId, outcome))
        return
      }
      case 'config-discord-connection-remove': {
        const outcome = yield* options.removeDiscordConnection(action.connectionId)
        yield* Console.log(formatDiscordConnectionRemove(action.connectionId, outcome))
        return
      }
      case 'config-discord-connection-enable': {
        const outcome = yield* options.enableDiscordConnection(action.connectionId)
        yield* Console.log(formatDiscordConnectionEnable(action.connectionId, outcome))
        return
      }
      case 'config-discord-connection-disable': {
        const outcome = yield* options.disableDiscordConnection(action.connectionId)
        yield* Console.log(formatDiscordConnectionDisable(action.connectionId, outcome))
        return
      }
      case 'config-discord-connection-get': {
        const detail = yield* options.getDiscordConnection(action.connectionId)
        yield* Console.log(
          Option.match(detail, {
            onNone: () => `Discord connection ${action.connectionId} is not configured.`,
            onSome: (connection) =>
              action.json ? JSON.stringify(connection) : renderDiscordConnectionDetail(connection),
          }),
        )
        return
      }
      case 'config-discord-connection-list': {
        const connections = yield* options.listDiscordConnections()
        yield* Console.log(
          action.json ? JSON.stringify(connections) : renderDiscordConnectionList(connections),
        )
        return
      }
      case 'config-discord-guild-enable': {
        const outcome = yield* options.enableDiscordGuild(action.connectionId, action.guildId)
        yield* Console.log(formatDiscordGuildEnable(action.guildId, outcome))
        return
      }
      case 'config-discord-guild-disable': {
        const outcome = yield* options.disableDiscordGuild(action.connectionId, action.guildId)
        yield* Console.log(formatDiscordGuildDisable(action.guildId, outcome))
        return
      }
      case 'config-discord-guild-remove': {
        const outcome = yield* options.removeDiscordGuild(action.connectionId, action.guildId)
        yield* Console.log(formatDiscordGuildRemove(action.guildId, outcome))
        return
      }
      case 'config-discord-guild-list': {
        const guilds = yield* options.listDiscordGuilds(action.connectionId)
        yield* Console.log(action.json ? JSON.stringify(guilds) : renderDiscordGuildList(guilds))
        return
      }
      case 'config-discord-guild-set-invocation': {
        const outcome = yield* options.setDiscordGuildInvocation(
          action.connectionId,
          action.guildId,
          action.mode,
        )
        yield* Console.log(formatDiscordGuildInvocation(action.guildId, action.mode, outcome))
        return
      }
      case 'config-discord-guild-set-users': {
        const outcome = yield* options.setDiscordGuildUsers(
          action.connectionId,
          action.guildId,
          action.policy,
        )
        yield* Console.log(formatDiscordGuildUsers(action.guildId, action.policy, outcome))
        return
      }
      case 'config-discord-guild-channel-set': {
        const outcome = yield* options.setDiscordGuildChannel(
          action.connectionId,
          action.guildId,
          action.channelId,
          action.patch,
        )
        yield* Console.log(formatDiscordGuildChannelSet(action.channelId, outcome))
        return
      }
      case 'config-discord-guild-channel-reset': {
        const outcome = yield* options.resetDiscordGuildChannel(
          action.connectionId,
          action.guildId,
          action.channelId,
        )
        yield* Console.log(formatDiscordGuildChannelReset(action.channelId, outcome))
        return
      }
      case 'config-discord-activity-description-set':
      case 'config-discord-activity-description-reset': {
        const enabled = action.type === 'config-discord-activity-description-set'
        yield* options.setDiscordActivityDescription(action, enabled)
        yield* Console.log(
          enabled
            ? `Discord activity description for ${action.connectionId} enabled. ${activityDescriptionNote}`
            : `Discord activity description for ${action.connectionId} disabled. Friday-owned text will be cleared. ${activityDescriptionNote}`,
        )
        return
      }
      case 'workspace-cleanup-apply': {
        const result = yield* options.applyWorkspaceCleanup(action, process.cwd())
        yield* Console.log(action.json ? JSON.stringify(result) : renderCleanup(result))
        return
      }
      case 'workspace-cleanup-list': {
        const proposals = yield* options.listWorkspaceCleanupProposals()
        yield* Console.log(
          action.json ? JSON.stringify(proposals) : renderWorkspaceCleanupList(proposals),
        )
        return
      }
      case 'worktree-ensure': {
        const result = yield* options.ensureWorktree(action)
        yield* Console.log(action.json ? JSON.stringify(result) : renderWorktree(result))
        return
      }
      case 'worktree-list': {
        const worktrees = yield* options.listWorktrees()
        yield* Console.log(action.json ? JSON.stringify(worktrees) : renderWorktreeList(worktrees))
        return
      }
      case 'start':
        return yield* options.start
    }
  })
