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

export const FRIDAY_VERSION = '0.0.0-nightly.15'

/**
 * One node of the CLI command tree: the typed source of parsing, validation,
 * and help. A branch lists its children, a leaf parses the tokens
 * after its own command path, and a removed node rejects an old command form
 * with a pointer to its replacement while staying out of help.
 */
export interface CliLeafSpec {
  readonly name: string
  readonly summary: string
  /** Usage fragments for a leaf command; fragments continue on wrapped lines. */
  readonly arguments?: ReadonlyArray<string>
  /**
   * Parses the tokens after the leaf's command path into a typed action.
   * `all` is the complete original argument list, for error reporting.
   */
  readonly parse: (
    tokens: ReadonlyArray<string>,
    all: ReadonlyArray<string>,
  ) => Effect.Effect<FridayCliAction, FridayCliError>
}

export interface CliBranchSpec {
  readonly name: string
  readonly summary: string
  readonly children: ReadonlyArray<CliCommandSpec>
}

export interface CliRemovedSpec {
  readonly name: string
  /** The removed command form, named in the rejection message. */
  readonly removed: string
  /** The replacement command form, named in the rejection message. */
  readonly replacement: string
}

export type CliCommandSpec = CliLeafSpec | CliBranchSpec | CliRemovedSpec

export const isCliBranch = (node: CliCommandSpec): node is CliBranchSpec => 'children' in node
export const isCliRemoved = (node: CliCommandSpec): node is CliRemovedSpec => 'removed' in node
const isLeaf = (node: CliCommandSpec): node is CliLeafSpec =>
  !isCliBranch(node) && !isCliRemoved(node)

const permissionPoliciesNote = `Permission policies are "all", "allow=<id>[,<id>...]", or "deny=<id>[,<id>...]".
The default reply mode is reply-in-thread; channels already inside a
user-created thread always stay in that thread.`

/** Resolves the command node at a topic path, if the path names a live node. */
export const findCommandSpec = (path: ReadonlyArray<string>): CliCommandSpec | undefined => {
  let node: CliCommandSpec = cliCommandSpec
  for (const name of path) {
    if (!isCliBranch(node)) return undefined
    const child: CliCommandSpec | undefined = node.children.find(
      (candidate) => candidate.name === name,
    )
    if (child === undefined) return undefined
    node = child
  }
  return node
}

/** Resolves the deepest command prefix of the arguments as the help topic. */
const helpTopic = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const topic: string[] = []
  let node: CliCommandSpec = cliCommandSpec
  for (const argument of arguments_) {
    if (!isCliBranch(node)) break
    const child: CliCommandSpec | undefined = node.children.find(
      (candidate) => candidate.name === argument,
    )
    // Removed command forms are not help topics; help falls back to their parent.
    if (child === undefined || isCliRemoved(child)) break
    topic.push(child.name)
    node = child
  }
  return topic
}

const renderEntry = (path: ReadonlyArray<string>, leaf: CliLeafSpec): ReadonlyArray<string> => [
  `  ${path.join(' ')}${leaf.arguments?.[0] === undefined ? '' : ` ${leaf.arguments[0]}`}`,
  ...(leaf.arguments ?? []).slice(1).map((line) => `      ${line}`),
  `      ${leaf.summary}`,
]

const renderLeafEntries = (
  node: CliBranchSpec,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  node.children.flatMap((child): ReadonlyArray<string> => {
    if (isCliRemoved(child)) return []
    const childPath = [...path, child.name]
    return isCliBranch(child) ? renderLeafEntries(child, childPath) : renderEntry(childPath, child)
  })

const renderChildEntries = (node: CliBranchSpec): ReadonlyArray<string> =>
  node.children.flatMap((child): ReadonlyArray<string> => {
    if (isCliRemoved(child)) return []
    return isCliBranch(child)
      ? [`  ${child.name}`, `      ${child.summary}`]
      : renderEntry([child.name], child)
  })

/**
 * Renders help for one command topic: the full command listing for the empty
 * topic, child commands for a branch, or the exact usage for a leaf. Removed
 * forms and unknown topics fall back to the full listing.
 */
export const renderCliHelp = (topic: ReadonlyArray<string> = []): string => {
  const node = findCommandSpec(topic)
  if (node === undefined || isCliRemoved(node)) return renderCliHelp([])
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
  if (isLeaf(node)) {
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

const discordArgumentsError = (all: ReadonlyArray<string>) =>
  new FridayCliError({ argument: all.join(' ') })

/** A typed rejection explaining the removal of a command form. */
const removedCommandError = (all: ReadonlyArray<string>, removed: string, replacement: string) =>
  new FridayCliError({
    argument: all.join(' '),
    detail: `The '${removed}' command was removed; use '${replacement}' instead.`,
  })

/** Names a command prefix; the root command is plain `friday`. */
const commandPathName = (path: ReadonlyArray<string>): string => ['friday', ...path].join(' ')

/** The usable subcommand names of a branch: removed forms are not usable. */
const knownSubcommandNames = (branch: CliBranchSpec): string =>
  branch.children
    .filter((child) => !isCliRemoved(child))
    .map((child) => child.name)
    .join(', ')

/** A typed rejection naming the known subcommands at a command prefix. */
const unknownSubcommandError = (
  path: ReadonlyArray<string>,
  head: string,
  branch: CliBranchSpec,
  all: ReadonlyArray<string>,
) =>
  new FridayCliError({
    argument: all.join(' '),
    detail: `Unknown '${commandPathName(path)}' subcommand '${head}'. Known subcommands: ${knownSubcommandNames(branch)}.`,
  })

/** A typed rejection when a command prefix stops without its subcommand. */
const missingSubcommandError = (
  path: ReadonlyArray<string>,
  branch: CliBranchSpec,
  all: ReadonlyArray<string>,
) =>
  new FridayCliError({
    argument: all.join(' '),
    detail: `Provide a subcommand of '${commandPathName(path)}'. Known subcommands: ${knownSubcommandNames(branch)}.`,
  })

/** Parses one required positional token, rejecting flags and missing values. */
const positionalToken = (
  tokens: ReadonlyArray<string>,
  index: number,
  all: ReadonlyArray<string>,
): Effect.Effect<string, FridayCliError> => {
  const token = tokens[index]
  return token === undefined || token.startsWith('-')
    ? Effect.fail(discordArgumentsError(all))
    : Effect.succeed(token)
}

/** Parses an optional trailing `--json` output flag and nothing else. */
const parseTrailingJson = (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
): Effect.Effect<boolean, FridayCliError> =>
  tokens.length > 1 || (tokens.length === 1 && tokens[0] !== '--json')
    ? Effect.fail(discordArgumentsError(all))
    : Effect.succeed(tokens[0] === '--json')

const parseStart = Effect.fn('Cli.parseStart')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length > 0) return yield* discordArgumentsError(all)
  return { type: 'start' as const }
})

const parseConfigReload = Effect.fn('Cli.parseConfigReload')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length > 0) return yield* discordArgumentsError(all)
  return { type: 'config-reload' as const }
})

const parseAdminDiscordAdd = Effect.fn('Cli.parseAdminDiscordAdd')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 1) return yield* discordArgumentsError(all)
  const userId = yield* decodeDiscordUserId(tokens[0] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return { type: 'config-admin-discord-add' as const, userId }
})

const parseAdminDiscordRemove = Effect.fn('Cli.parseAdminDiscordRemove')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 1) return yield* discordArgumentsError(all)
  const userId = yield* decodeDiscordUserId(tokens[0] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return { type: 'config-admin-discord-remove' as const, userId }
})

const parseAdminDiscordList = Effect.fn('Cli.parseAdminDiscordList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'config-admin-discord-list' as const, json }
})

const parseActivityDescription = (enabled: boolean) =>
  Effect.fn('Cli.parseActivityDescription')(function* (
    tokens: ReadonlyArray<string>,
    all: ReadonlyArray<string>,
  ) {
    if (tokens.length !== 1) return yield* discordArgumentsError(all)
    const connectionId = yield* decodePlatformConnectionId(tokens[0] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
    return {
      type: enabled
        ? ('config-discord-activity-description-set' as const)
        : ('config-discord-activity-description-reset' as const),
      connectionId,
    }
  })

const parseConnectionList = Effect.fn('Cli.parseConnectionList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'config-discord-connection-list' as const, json }
})

/** Rejects missing and flag-like values before a command-specific decoder runs. */
const connectionFlagValue = (
  value: string | undefined,
  all: ReadonlyArray<string>,
): Effect.Effect<string, FridayCliError> =>
  value === undefined || value.startsWith('-')
    ? Effect.fail(discordArgumentsError(all))
    : Effect.succeed(value)

const decodeConnectionName = Schema.decodeUnknownEffect(
  Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
)
const decodeDiscordPublicKey = Schema.decodeUnknownEffect(DiscordPublicKey)
const decodeBotTokenEnvName = Schema.decodeUnknownEffect(BotTokenEnvName)

const missingUpdateFieldError = (all: ReadonlyArray<string>) =>
  new FridayCliError({
    argument: all.join(' '),
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
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length < 1) return yield* missingUpdateFieldError(all)
    const connectionId = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodePlatformConnectionId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    let name: string | undefined
    let applicationId: typeof DiscordSnowflake.Type | undefined
    let publicKey: typeof DiscordPublicKey.Type | undefined
    let botTokenEnv: typeof BotTokenEnvName.Type | undefined
    let respondToGlobalMentions: boolean | undefined
    let index = 1
    while (index < tokens.length) {
      const flag = tokens[index]
      if (flag === '--respond-to-global-mentions') {
        if (respondToGlobalMentions !== undefined) return yield* discordArgumentsError(all)
        respondToGlobalMentions = true
        index += 1
        continue
      }
      if (flag === '--no-respond-to-global-mentions') {
        if (respondToGlobalMentions !== undefined) return yield* discordArgumentsError(all)
        respondToGlobalMentions = false
        index += 1
        continue
      }
      const value = tokens[index + 1]
      if (flag === '--name') {
        if (name !== undefined) return yield* discordArgumentsError(all)
        name = yield* connectionFlagValue(value, all).pipe(
          Effect.flatMap(decodeConnectionName),
          Effect.mapError(() => discordArgumentsError(all)),
        )
        index += 2
        continue
      }
      if (flag === '--application-id') {
        if (applicationId !== undefined) return yield* discordArgumentsError(all)
        applicationId = yield* connectionFlagValue(value, all).pipe(
          Effect.flatMap(decodeDiscordSnowflake),
          Effect.mapError(() => discordArgumentsError(all)),
        )
        index += 2
        continue
      }
      if (flag === '--public-key') {
        if (publicKey !== undefined) return yield* discordArgumentsError(all)
        publicKey = yield* connectionFlagValue(value, all).pipe(
          Effect.flatMap(decodeDiscordPublicKey),
          Effect.mapError(() => discordArgumentsError(all)),
        )
        index += 2
        continue
      }
      if (flag === '--bot-token-env') {
        if (botTokenEnv !== undefined) return yield* discordArgumentsError(all)
        botTokenEnv = yield* connectionFlagValue(value, all).pipe(
          Effect.flatMap(decodeBotTokenEnvName),
          Effect.mapError(() => discordArgumentsError(all)),
        )
        index += 2
        continue
      }
      return yield* discordArgumentsError(all)
    }
    if (
      name === undefined &&
      applicationId === undefined &&
      publicKey === undefined &&
      botTokenEnv === undefined &&
      respondToGlobalMentions === undefined
    ) {
      return yield* missingUpdateFieldError(all)
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
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const connectionId = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodePlatformConnectionId),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  let name: string | undefined
  let applicationId: typeof DiscordSnowflake.Type | undefined
  let publicKey: typeof DiscordPublicKey.Type | undefined
  let botTokenEnv: typeof BotTokenEnvName.Type | undefined
  let respondToGlobalMentions = false
  let index = 1
  while (index < tokens.length) {
    const flag = tokens[index]
    if (flag === '--respond-to-global-mentions') {
      respondToGlobalMentions = true
      index += 1
      continue
    }
    const value = tokens[index + 1]
    if (flag === '--name') {
      if (name !== undefined) return yield* discordArgumentsError(all)
      name = yield* connectionFlagValue(value, all).pipe(
        Effect.flatMap(decodeConnectionName),
        Effect.mapError(() => discordArgumentsError(all)),
      )
      index += 2
      continue
    }
    if (flag === '--application-id') {
      if (applicationId !== undefined) return yield* discordArgumentsError(all)
      applicationId = yield* connectionFlagValue(value, all).pipe(
        Effect.flatMap(decodeDiscordSnowflake),
        Effect.mapError(() => discordArgumentsError(all)),
      )
      index += 2
      continue
    }
    if (flag === '--public-key') {
      if (publicKey !== undefined) return yield* discordArgumentsError(all)
      publicKey = yield* connectionFlagValue(value, all).pipe(
        Effect.flatMap(decodeDiscordPublicKey),
        Effect.mapError(() => discordArgumentsError(all)),
      )
      index += 2
      continue
    }
    if (flag === '--bot-token-env') {
      if (botTokenEnv !== undefined) return yield* discordArgumentsError(all)
      botTokenEnv = yield* connectionFlagValue(value, all).pipe(
        Effect.flatMap(decodeBotTokenEnvName),
        Effect.mapError(() => discordArgumentsError(all)),
      )
      index += 2
      continue
    }
    return yield* discordArgumentsError(all)
  }
  if (
    name === undefined ||
    applicationId === undefined ||
    publicKey === undefined ||
    botTokenEnv === undefined
  ) {
    return yield* discordArgumentsError(all)
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
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length !== 2 || tokens[1] !== '--yes') {
      return yield* discordArgumentsError(all)
    }
    const connectionId = yield* decodePlatformConnectionId(tokens[0] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
    return {
      type: 'config-discord-connection-remove' as const,
      connectionId,
      yes: true,
    }
  },
)

const parseConnectionEnableDisable = (enable: boolean) =>
  Effect.fn('Cli.parseConnectionEnableDisable')(function* (
    tokens: ReadonlyArray<string>,
    all: ReadonlyArray<string>,
  ) {
    if (tokens.length !== 1) return yield* discordArgumentsError(all)
    const connectionId = yield* decodePlatformConnectionId(tokens[0] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
    return {
      type: enable
        ? ('config-discord-connection-enable' as const)
        : ('config-discord-connection-disable' as const),
      connectionId,
    }
  })

const parseConfigDiscordConnectionGet = Effect.fn('Cli.parseConfigDiscordConnectionGet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length < 1 || tokens.length > 2) return yield* discordArgumentsError(all)
  const connectionId = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodePlatformConnectionId),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const json = yield* parseTrailingJson(tokens.slice(1), all)
  return { type: 'config-discord-connection-get' as const, connectionId, json }
})

const parseConnectionGuild = Effect.fn('Cli.parseConnectionGuild')(function* (
  tokens: ReadonlyArray<string>,
  connectionIndex: number,
  guildIndex: number,
  all: ReadonlyArray<string>,
) {
  const connectionArgument = yield* positionalToken(tokens, connectionIndex, all)
  const guildArgument = yield* positionalToken(tokens, guildIndex, all)
  const connectionId = yield* decodePlatformConnectionId(connectionArgument).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const guildId = yield* decodeDiscordGuildId(guildArgument).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return { connectionId, guildId }
})

const guildRemoveConfirmationError = (all: ReadonlyArray<string>) =>
  new FridayCliError({
    argument: all.join(' '),
    detail:
      "Guild removal also deletes the guild's channel overrides; re-run with --yes to confirm.",
  })

const parseConfigDiscordGuildEnable = Effect.fn('Cli.parseConfigDiscordGuildEnable')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 2) return yield* discordArgumentsError(all)
  const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
  return { type: 'config-discord-guild-enable' as const, connectionId, guildId }
})

const parseConfigDiscordGuildDisable = Effect.fn('Cli.parseConfigDiscordGuildDisable')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 2) return yield* discordArgumentsError(all)
  const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
  return { type: 'config-discord-guild-disable' as const, connectionId, guildId }
})

const parseConfigDiscordGuildRemove = Effect.fn('Cli.parseConfigDiscordGuildRemove')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length === 2) return yield* guildRemoveConfirmationError(all)
  if (tokens.length !== 3 || tokens[2] !== '--yes') {
    return yield* discordArgumentsError(all)
  }
  const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
  return { type: 'config-discord-guild-remove' as const, connectionId, guildId, yes: true }
})

const parseConfigDiscordGuildList = Effect.fn('Cli.parseConfigDiscordGuildList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length < 1 || tokens.length > 2) return yield* discordArgumentsError(all)
  const connectionId = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodePlatformConnectionId),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const json = yield* parseTrailingJson(tokens.slice(1), all)
  return { type: 'config-discord-guild-list' as const, connectionId, json }
})

const parseConfigDiscordGuildSetInvocation = Effect.fn('Cli.parseConfigDiscordGuildSetInvocation')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length !== 3) return yield* discordArgumentsError(all)
    const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
    const mode = yield* decodeInvocationMode(tokens[2] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
    return { type: 'config-discord-guild-set-invocation' as const, connectionId, guildId, mode }
  },
)

const parseConfigDiscordGuildSetUsers = Effect.fn('Cli.parseConfigDiscordGuildSetUsers')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 3) return yield* discordArgumentsError(all)
  const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
  const policy = yield* parseAccessPolicySpec(tokens[2] ?? '')
  return { type: 'config-discord-guild-set-users' as const, connectionId, guildId, policy }
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

const parseConfigDiscordGuildChannelReset = Effect.fn('Cli.parseConfigDiscordGuildChannelReset')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length !== 3) return yield* discordArgumentsError(all)
    const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
    const channelId = yield* decodeDiscordGuildChannelId(tokens[2] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
    return {
      type: 'config-discord-guild-channel-reset' as const,
      connectionId,
      guildId,
      channelId,
    }
  },
)

const parseConfigDiscordGuildChannelSet = Effect.fn('Cli.parseConfigDiscordGuildChannelSet')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length < 3) return yield* discordArgumentsError(all)
    const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
    const channelId = yield* positionalToken(tokens, 2, all).pipe(
      Effect.flatMap(decodeDiscordGuildChannelId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    let invocationMode: InvocationModeType | undefined
    let users: AccessPolicy | undefined
    let replyMode: 'reply-in-thread' | 'reply-in-channel' | undefined
    let index = 3
    while (index < tokens.length) {
      const flag = tokens[index]
      if (flag === '--reply-in-thread' || flag === '--reply-in-channel') {
        if (replyMode !== undefined) return yield* discordArgumentsError(all)
        replyMode = flag === '--reply-in-thread' ? 'reply-in-thread' : 'reply-in-channel'
        index += 1
        continue
      }
      const value = tokens[index + 1]
      if (flag === '--invocation') {
        if (invocationMode !== undefined || value === undefined) {
          return yield* discordArgumentsError(all)
        }
        invocationMode = yield* decodeInvocationMode(value).pipe(
          Effect.mapError(() => discordArgumentsError(all)),
        )
        index += 2
        continue
      }
      if (flag === '--users') {
        if (users !== undefined || value === undefined) {
          return yield* discordArgumentsError(all)
        }
        users = yield* parseAccessPolicySpec(value)
        index += 2
        continue
      }
      return yield* discordArgumentsError(all)
    }
    if (invocationMode === undefined && users === undefined && replyMode === undefined) {
      // A channel set with no overrides would be a no-op row.
      return yield* discordArgumentsError(all)
    }
    return {
      type: 'config-discord-guild-channel-set' as const,
      connectionId,
      guildId,
      channelId,
      patch: buildChannelPatch(invocationMode, users, replyMode),
    }
  },
)

const parseWorktreeEnsure = Effect.fn('Cli.parseWorktreeEnsure')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const url = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeRepositoryUrl),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  let workspace: string | undefined
  let ref: string | undefined
  let json = false
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = tokens[index]
    if (flag === '--json') {
      json = true
      continue
    }
    if (flag === '--workspace' || flag === '--ref') {
      const value = tokens[index + 1]
      if (!value || value.startsWith('-')) {
        return yield* discordArgumentsError(all)
      }
      if (flag === '--workspace') workspace = value
      else ref = value
      index += 1
      continue
    }
    return yield* discordArgumentsError(all)
  }
  if (workspace !== undefined && ref !== undefined) {
    return { type: 'worktree-ensure' as const, url, workspace, ref, json }
  }
  if (workspace !== undefined) return { type: 'worktree-ensure' as const, url, workspace, json }
  if (ref !== undefined) return { type: 'worktree-ensure' as const, url, ref, json }
  return { type: 'worktree-ensure' as const, url, json }
})

const parseWorktreeList = Effect.fn('Cli.parseWorktreeList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'worktree-list' as const, json }
})

const parseWorkspaceCleanupApply = Effect.fn('Cli.parseWorkspaceCleanupApply')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const proposalId = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeWorkspaceCleanupProposalId),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const json = yield* parseTrailingJson(tokens.slice(1), all)
  return { type: 'workspace-cleanup-apply' as const, proposalId, json }
})

const parseWorkspaceCleanupList = Effect.fn('Cli.parseWorkspaceCleanupList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'workspace-cleanup-list' as const, json }
})

/** The complete Friday CLI command tree used by parsing, validation, and help. */
export const cliCommandSpec: CliBranchSpec = {
  name: 'friday',
  summary: 'Friday — your personal agent.',
  children: [
    {
      name: 'start',
      summary: 'Start Friday (the default when no command is given).',
      parse: parseStart,
    },
    {
      name: 'config',
      summary: "View or change Friday's stored configuration.",
      children: [
        {
          name: 'reload',
          summary: 'Reload the running Friday configuration.',
          parse: parseConfigReload,
        },
        {
          name: 'admin',
          summary: "Manage Friday's administrator allow-list (changes need a restart).",
          children: [
            {
              name: 'discord',
              summary: 'Manage the Discord administrator allow-list.',
              children: [
                {
                  name: 'add',
                  summary: 'Add a Discord administrator.',
                  arguments: ['<user-id>'],
                  parse: parseAdminDiscordAdd,
                },
                {
                  name: 'remove',
                  summary: 'Remove a Discord administrator.',
                  arguments: ['<user-id>'],
                  parse: parseAdminDiscordRemove,
                },
                {
                  name: 'list',
                  summary: 'List configured Discord administrators.',
                  arguments: ['[--json]'],
                  parse: parseAdminDiscordList,
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
                  parse: parseConfigDiscordConnectionAdd,
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
                  parse: parseConfigDiscordConnectionUpdate,
                },
                {
                  name: 'remove',
                  summary: 'Remove a connection and its Discord configuration (needs a restart).',
                  arguments: ['<connection-id> --yes'],
                  parse: parseConfigDiscordConnectionRemove,
                },
                {
                  name: 'enable',
                  summary: 'Enable a configured connection (needs a restart).',
                  arguments: ['<connection-id>'],
                  parse: parseConnectionEnableDisable(true),
                },
                {
                  name: 'disable',
                  summary: 'Disable a configured connection (needs a restart).',
                  arguments: ['<connection-id>'],
                  parse: parseConnectionEnableDisable(false),
                },
                {
                  name: 'get',
                  summary: "Show one connection's stored configuration.",
                  arguments: ['<connection-id> [--json]'],
                  parse: parseConfigDiscordConnectionGet,
                },
                {
                  name: 'list',
                  summary: 'List configured Discord connections.',
                  arguments: ['[--json]'],
                  parse: parseConnectionList,
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
                  parse: parseConfigDiscordGuildEnable,
                },
                {
                  name: 'disable',
                  summary: 'Disable Friday in a guild.',
                  arguments: ['<connection-id> <guild-id>'],
                  parse: parseConfigDiscordGuildDisable,
                },
                {
                  name: 'remove',
                  summary: "Remove a guild's configuration and its channel overrides.",
                  arguments: ['<connection-id> <guild-id> --yes'],
                  parse: parseConfigDiscordGuildRemove,
                },
                {
                  name: 'list',
                  summary: "List a connection's guild configuration.",
                  arguments: ['<connection-id> [--json]'],
                  parse: parseConfigDiscordGuildList,
                },
                {
                  name: 'set-invocation',
                  summary: 'Set the guild-wide invocation default.',
                  arguments: ['<connection-id> <guild-id> <mention-only|all-messages>'],
                  parse: parseConfigDiscordGuildSetInvocation,
                },
                {
                  name: 'set-users',
                  summary: 'Set the guild-wide user permission default.',
                  arguments: ['<connection-id> <guild-id> <all|allow=<id>[,...]|deny=<id>[,...]>'],
                  parse: parseConfigDiscordGuildSetUsers,
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
                      parse: parseConfigDiscordGuildChannelSet,
                    },
                    {
                      name: 'reset',
                      summary: 'Remove channel overrides; guild defaults apply again.',
                      arguments: ['<connection-id> <guild-id> <channel-id>'],
                      parse: parseConfigDiscordGuildChannelReset,
                    },
                  ],
                },
                {
                  name: 'invocation',
                  removed: 'config discord guild invocation set',
                  replacement:
                    'friday config discord guild set-invocation <connection-id> <guild-id> <mode>',
                },
                {
                  name: 'users',
                  removed: 'config discord guild users set',
                  replacement:
                    'friday config discord guild set-users <connection-id> <guild-id> <policy>',
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
                  parse: parseActivityDescription(true),
                },
                {
                  name: 'reset',
                  summary: 'Disable it and clear Friday-owned description text now.',
                  arguments: ['<connection-id>'],
                  parse: parseActivityDescription(false),
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'worktree',
      summary: 'Manage repository worktrees registered with Friday.',
      children: [
        {
          name: 'ensure',
          summary: 'Ensure a reusable repository worktree for the current channel workspace.',
          arguments: ['<repository-url> [--ref <ref>] [--workspace <path>] [--json]'],
          parse: parseWorktreeEnsure,
        },
        {
          name: 'list',
          summary: 'List repository worktrees registered with Friday.',
          arguments: ['[--json]'],
          parse: parseWorktreeList,
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
              parse: parseWorkspaceCleanupApply,
            },
            {
              name: 'list',
              summary: 'List recorded workspace cleanup proposals.',
              arguments: ['[--json]'],
              parse: parseWorkspaceCleanupList,
            },
          ],
        },
      ],
    },
    {
      name: 'platform',
      removed: 'platform activity-description set|reset',
      replacement: 'friday config discord activity-description set|reset <connection-id>',
    },
  ],
}

/**
 * Walks the typed command tree: a matched child deepens the path, a branch
 * prefix without or with an unknown subcommand fails with the known child
 * list, a removed form fails with its replacement pointer, and a leaf parses
 * its own remaining tokens.
 */
const dispatchCommand = (
  path: ReadonlyArray<string>,
  node: CliCommandSpec,
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
): Effect.Effect<FridayCliAction, FridayCliError> => {
  if (isCliRemoved(node)) {
    return Effect.fail(removedCommandError(all, node.removed, node.replacement))
  }
  if (isLeaf(node)) return node.parse(tokens, all)
  const [head, ...rest] = tokens
  if (head === undefined) return Effect.fail(missingSubcommandError(path, node, all))
  const child = node.children.find((candidate) => candidate.name === head)
  if (child === undefined) return Effect.fail(unknownSubcommandError(path, head, node, all))
  return dispatchCommand([...path, child.name], child, rest, all)
}

export const parseFridayCli = (
  all: ReadonlyArray<string>,
): Effect.Effect<FridayCliAction, FridayCliError> => {
  const helpIndex = all.findIndex((argument) => argument === '-h' || argument === '--help')
  if (helpIndex >= 0) {
    return Effect.succeed({ type: 'help', topic: helpTopic(all.slice(0, helpIndex)) })
  }
  if (all.length === 1 && (all[0] === '--version' || all[0] === '-v')) {
    return Effect.succeed({ type: 'version' })
  }
  // With no arguments Friday starts; `start` is also a regular tree command.
  if (all.length === 0) return Effect.succeed({ type: 'start' })
  return dispatchCommand([], cliCommandSpec, all, all)
}

const renderCleanup = (
  proposal: WorkspaceCleanupProposal,
): string => `Workspace cleanup ${proposal.status}
  Proposal: ${proposal.id}
  Worktrees removed: ${proposal.resources.filter((resource) => resource.removalStatus === 'removed').length}/${proposal.resources.length}
  Estimated reclaimed: ${proposal.estimatedBytes} bytes`

export interface WorktreeRepositoryGroup {
  readonly url: string
  readonly worktrees: ReadonlyArray<ManagedWorktreeListEntry>
}

/** Groups the flat registry listing by owning repository for human output. */
export const groupWorktreesByRepository = (
  worktrees: ReadonlyArray<ManagedWorktreeListEntry>,
): ReadonlyArray<WorktreeRepositoryGroup> => {
  const groups = new Map<string, Array<ManagedWorktreeListEntry>>()
  for (const worktree of worktrees) {
    const existing = groups.get(worktree.url)
    if (existing === undefined) groups.set(worktree.url, [worktree])
    else existing.push(worktree)
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([url, grouped]) => ({
      url,
      worktrees: grouped.toSorted((left, right) => left.path.localeCompare(right.path)),
    }))
}

const renderWorktreeLine = (worktree: ManagedWorktreeListEntry): string =>
  `    ${worktree.path}  ${worktree.branch === null ? '(detached head)' : worktree.branch}  ${worktree.head.slice(0, 12)}${worktree.prunable ? '  (missing on disk)' : ''}`

/** Human output groups registered worktrees by their owning repository. */
export const renderWorktreeList = (worktrees: ReadonlyArray<ManagedWorktreeListEntry>): string =>
  worktrees.length === 0
    ? 'No repository worktrees are registered with Friday.'
    : [
        'Repository worktrees:',
        ...groupWorktreesByRepository(worktrees).flatMap((group) => [
          `  ${group.url}`,
          ...group.worktrees.map(renderWorktreeLine),
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
              `    Worktree: ${resource.path} (${resource.branch}, ${resource.sizeBytes} bytes, ${resource.removalStatus})`,
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

export type FridayCliOperations<
  E,
  WorktreeError,
  CleanupError,
  ActivityDescriptionError,
  GuildError,
  ReloadError,
  AdminError,
  ConnectionError,
> = {
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
}

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
  options: FridayCliOperations<
    E,
    WorktreeError,
    CleanupError,
    ActivityDescriptionError,
    GuildError,
    ReloadError,
    AdminError,
    ConnectionError
  >,
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
      default: {
        const unhandled: never = action
        return unhandled
      }
    }
  })
