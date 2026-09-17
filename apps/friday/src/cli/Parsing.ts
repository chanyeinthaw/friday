import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  ModelId,
  PlatformConnectionId,
  ProviderId,
  SubagentProfileName,
  ThinkingLevel,
} from '@friday/contracts/conversation'

import {
  type AccessPolicy,
  InvocationMode,
  type InvocationMode as InvocationModeType,
  type ReplyMode as ReplyModeType,
} from '../config/AppConfig.ts'
import {
  DiscordGuildChannelId,
  DiscordGuildId,
  DiscordSnowflake,
  type DiscordGuildChannelPatch,
} from '../config/DiscordGuilds.ts'
import { BotTokenEnvName, DiscordPublicKey } from '../config/DiscordConnections.ts'
import {
  SlackChannelId,
  SlackTokenEnvName,
  type SlackAccessSubject,
  type SlackChannelPatch,
} from '../config/SlackConnections.ts'
import { DiscordUserId } from '../config/DiscordAdmins.ts'
import { RootUserId, RootUserPlatform, RootUserScopeId } from '../config/RootUsers.ts'
import { IdentityText } from '../config/IdentityConfiguration.ts'
import { FixedModelName } from '../config/ModelConfiguration.ts'
import { RepositoryUrl } from '../repositories/RepositoryWorktrees.ts'
import { WorkspaceCleanupProposalId } from '../workspaces/WorkspaceCleanup.ts'
import {
  DocumentKey,
  type DocumentConfigPatch,
  type DocumentFormat,
} from '../documents/Documents.ts'
import { FridayCliError, type FridayCliAction } from './Types.ts'
import { ControlSocketError } from '../control/ControlSocket.ts'
import { isCliRemoved, type CliBranchSpec } from './Command.ts'

const decodeRepositoryUrl = Schema.decodeUnknownEffect(RepositoryUrl)
const decodeFixedModelName = Schema.decodeUnknownEffect(FixedModelName)
const decodeProviderId = Schema.decodeUnknownEffect(ProviderId)
const decodeModelId = Schema.decodeUnknownEffect(ModelId)
const decodeThinkingLevel = Schema.decodeUnknownEffect(ThinkingLevel)
const decodeProfileName = Schema.decodeUnknownEffect(SubagentProfileName)
export const isControlSocketError = Schema.is(ControlSocketError)
const decodeProfileDescription = Schema.decodeUnknownEffect(
  Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
)
const decodeDocumentKey = Schema.decodeUnknownEffect(DocumentKey)
const decodeWorkspaceCleanupProposalId = Schema.decodeUnknownEffect(WorkspaceCleanupProposalId)
const decodePlatformConnectionId = Schema.decodeUnknownEffect(PlatformConnectionId)
const decodeInvocationMode = Schema.decodeUnknownEffect(InvocationMode)
const decodeDiscordUserId = Schema.decodeUnknownEffect(DiscordUserId)
const decodeRootUserPlatform = Schema.decodeUnknownEffect(RootUserPlatform)
const decodeRootUserScopeId = Schema.decodeUnknownEffect(RootUserScopeId)
const decodeRootUserId = Schema.decodeUnknownEffect(RootUserId)
const decodeIdentityText = Schema.decodeUnknownEffect(IdentityText)
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
export const removedCommandError = (
  all: ReadonlyArray<string>,
  removed: string,
  replacement: string,
) =>
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
export const unknownSubcommandError = (
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
export const missingSubcommandError = (
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
export const parseTrailingJson = (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
): Effect.Effect<boolean, FridayCliError> =>
  tokens.length > 1 || (tokens.length === 1 && tokens[0] !== '--json')
    ? Effect.fail(discordArgumentsError(all))
    : Effect.succeed(tokens[0] === '--json')

export const parseStart = Effect.fn('Cli.parseStart')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length > 0) return yield* discordArgumentsError(all)
  return { type: 'start' as const }
})

export const parseConfigReload = Effect.fn('Cli.parseConfigReload')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length > 0) return yield* discordArgumentsError(all)
  return { type: 'config-reload' as const }
})

export const parseFlags = (
  tokens: ReadonlyArray<string>,
  allowed: ReadonlySet<string>,
  booleans: ReadonlySet<string>,
  all: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, string | true>, FridayCliError> =>
  Effect.gen(function* () {
    const values = new Map<string, string | true>()
    for (let index = 0; index < tokens.length; index += 1) {
      const flag = tokens[index]
      if (flag === undefined || !allowed.has(flag) || values.has(flag))
        return yield* discordArgumentsError(all)
      if (booleans.has(flag)) {
        values.set(flag, true)
        continue
      }
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('-')) return yield* discordArgumentsError(all)
      values.set(flag, value)
      index += 1
    }
    return values
  })

const flagString = (
  values: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined => {
  const value = values.get(name)
  return value === true ? undefined : value
}

export const parseConfigModelList = Effect.fn('Cli.parseConfigModelList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'config-model-list' as const, json }
})
export const parseConfigModelGet = Effect.fn('Cli.parseConfigModelGet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const name = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeFixedModelName),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const json = yield* parseTrailingJson(tokens.slice(1), all)
  return { type: 'config-model-get' as const, name, json }
})
export const parseConfigModelSet = Effect.fn('Cli.parseConfigModelSet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const name = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeFixedModelName),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const flags = yield* parseFlags(
    tokens.slice(1),
    new Set(['--provider', '--model-id', '--thinking']),
    new Set(),
    all,
  )
  const provider = yield* decodeProviderId(flagString(flags, '--provider')).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const modelId = yield* decodeModelId(flagString(flags, '--model-id')).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const thinkingLevel = yield* decodeThinkingLevel(flagString(flags, '--thinking')).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return {
    type: 'config-model-set' as const,
    selection: { name, provider, modelId, thinkingLevel },
  }
})
export const parseConfigProfileList = Effect.fn('Cli.parseConfigProfileList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  return { type: 'config-profile-list' as const, json: yield* parseTrailingJson(tokens, all) }
})
export const parseConfigProfileGet = Effect.fn('Cli.parseConfigProfileGet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const name = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeProfileName),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return {
    type: 'config-profile-get' as const,
    name,
    json: yield* parseTrailingJson(tokens.slice(1), all),
  }
})
export const parseConfigProfileAdd = Effect.fn('Cli.parseConfigProfileAdd')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const name = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeProfileName),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const flags = yield* parseFlags(
    tokens.slice(1),
    new Set(['--description', '--provider', '--model-id', '--thinking']),
    new Set(),
    all,
  )
  const description = yield* decodeProfileDescription(flagString(flags, '--description')).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const provider = yield* decodeProviderId(flagString(flags, '--provider')).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const modelId = yield* decodeModelId(flagString(flags, '--model-id')).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const thinkingLevel = yield* decodeThinkingLevel(flagString(flags, '--thinking')).pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return {
    type: 'config-profile-add' as const,
    profile: { name, description, provider, modelId, thinkingLevel },
  }
})
export const parseConfigProfileUpdate = Effect.fn('Cli.parseConfigProfileUpdate')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const name = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeProfileName),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const flags = yield* parseFlags(
    tokens.slice(1),
    new Set(['--description', '--provider', '--model-id', '--thinking']),
    new Set(),
    all,
  )
  if (flags.size === 0) return yield* discordArgumentsError(all)
  const descriptionValue = flagString(flags, '--description')
  const providerValue = flagString(flags, '--provider')
  const modelIdValue = flagString(flags, '--model-id')
  const thinkingValue = flagString(flags, '--thinking')
  const patch: ParsedProfilePatch = { name }
  if (descriptionValue !== undefined) {
    patch.description = yield* decodeProfileDescription(descriptionValue).pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
  }
  if (providerValue !== undefined) {
    patch.provider = yield* decodeProviderId(providerValue).pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
  }
  if (modelIdValue !== undefined) {
    patch.modelId = yield* decodeModelId(modelIdValue).pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
  }
  if (thinkingValue !== undefined) {
    patch.thinkingLevel = yield* decodeThinkingLevel(thinkingValue).pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
  }
  return { type: 'config-profile-update' as const, patch }
})
export const parseConfigProfileRemove = Effect.fn('Cli.parseConfigProfileRemove')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const name = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeProfileName),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  if (tokens.length !== 2 || tokens[1] !== '--yes') return yield* discordArgumentsError(all)
  return { type: 'config-profile-remove' as const, name, yes: true }
})
export const parseModelList = Effect.fn('Cli.parseModelList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const flags = yield* parseFlags(
    tokens,
    new Set(['--provider', '--available', '--json']),
    new Set(['--available', '--json']),
    all,
  )
  const provider = flagString(flags, '--provider')
  const action: ParsedModelListAction = {
    type: 'model-list',
    available: flags.has('--available'),
    json: flags.has('--json'),
  }
  if (provider !== undefined) action.provider = provider
  return action
})
export const parseModelGet = Effect.fn('Cli.parseModelGet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const provider = yield* positionalToken(tokens, 0, all)
  const modelId = yield* positionalToken(tokens, 1, all)
  const json = yield* parseTrailingJson(tokens.slice(2), all)
  return { type: 'model-get' as const, provider, modelId, json }
})
export const parseModelReload = Effect.fn('Cli.parseModelReload')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length > 0) return yield* discordArgumentsError(all)
  return { type: 'model-reload' as const }
})

export const parseAdminDiscordAdd = Effect.fn('Cli.parseAdminDiscordAdd')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 1) return yield* discordArgumentsError(all)
  const userId = yield* decodeDiscordUserId(tokens[0] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return { type: 'config-admin-discord-add' as const, userId }
})

export const parseAdminDiscordRemove = Effect.fn('Cli.parseAdminDiscordRemove')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 1) return yield* discordArgumentsError(all)
  const userId = yield* decodeDiscordUserId(tokens[0] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return { type: 'config-admin-discord-remove' as const, userId }
})

export const parseAdminDiscordList = Effect.fn('Cli.parseAdminDiscordList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'config-admin-discord-list' as const, json }
})

export const parseRootUserIdentity = Effect.fn('Cli.parseRootUserIdentity')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 3) return yield* discordArgumentsError(all)
  const platform = yield* decodeRootUserPlatform(tokens[0] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const scopeId = yield* decodeRootUserScopeId(tokens[1] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const userId = yield* decodeRootUserId(tokens[2] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return { platform, scopeId, userId }
})

export const parseRootUserAdd = Effect.fn('Cli.parseRootUserAdd')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const rootUser = yield* parseRootUserIdentity(tokens, all)
  return { type: 'config-root-user-add' as const, ...rootUser }
})

export const parseRootUserRemove = Effect.fn('Cli.parseRootUserRemove')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const rootUser = yield* parseRootUserIdentity(tokens, all)
  return { type: 'config-root-user-remove' as const, ...rootUser }
})

export const parseRootUserList = Effect.fn('Cli.parseRootUserList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'config-root-user-list' as const, json }
})

export const parseIdentityGet = Effect.fn('Cli.parseIdentityGet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  return { type: 'config-identity-get' as const, json: yield* parseTrailingJson(tokens, all) }
})

export const parseIdentitySet = Effect.fn('Cli.parseIdentitySet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length !== 1) return yield* discordArgumentsError(all)
  const text = yield* decodeIdentityText(tokens[0] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return { type: 'config-identity-set' as const, text }
})

export const parseConnectionList = Effect.fn('Cli.parseConnectionList')(function* (
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

interface ParsedProfilePatch {
  name: SubagentProfileName
  description?: string
  provider?: ProviderId
  modelId?: ModelId
  thinkingLevel?: ThinkingLevel
}

interface ParsedModelListAction {
  type: 'model-list'
  provider?: string
  available: boolean
  json: boolean
}

export interface PiModelListOptions {
  provider?: string
  availableOnly?: boolean
}

/** Mutable assembly shape for the connection update parsed from CLI flags. */
interface ParsedDiscordConnectionUpdate {
  type: 'config-discord-connection-update'
  connectionId: PlatformConnectionId
  name?: string
  applicationId?: DiscordSnowflake
  publicKey?: DiscordPublicKey
  botTokenEnv?: BotTokenEnvName
  respondToGlobalMentions?: boolean
}

type DiscordConnectionUpdateField = Exclude<
  keyof ParsedDiscordConnectionUpdate,
  'type' | 'connectionId'
>

interface ParsedDiscordConnectionUpdateState {
  readonly action: ParsedDiscordConnectionUpdate
  readonly seen: Set<DiscordConnectionUpdateField>
}

const setDiscordConnectionUpdateField = Effect.fn('Cli.setDiscordConnectionUpdateField')(function* (
  state: ParsedDiscordConnectionUpdateState,
  field: DiscordConnectionUpdateField,
  value: string | undefined,
  all: ReadonlyArray<string>,
) {
  if (state.seen.has(field)) return yield* discordArgumentsError(all)
  const raw = yield* connectionFlagValue(value, all)
  if (field === 'name') {
    state.action.name = yield* decodeConnectionName(raw).pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
  } else if (field === 'applicationId') {
    state.action.applicationId = yield* decodeDiscordSnowflake(raw).pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
  } else if (field === 'publicKey') {
    state.action.publicKey = yield* decodeDiscordPublicKey(raw).pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
  } else {
    state.action.botTokenEnv = yield* decodeBotTokenEnvName(raw).pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
  }
  state.seen.add(field)
})

const connectionUpdateField = (
  flag: string | undefined,
): DiscordConnectionUpdateField | undefined =>
  flag === '--name'
    ? 'name'
    : flag === '--application-id'
      ? 'applicationId'
      : flag === '--public-key'
        ? 'publicKey'
        : flag === '--bot-token-env'
          ? 'botTokenEnv'
          : undefined

export const parseConfigDiscordConnectionUpdate = Effect.fn(
  'Cli.parseConfigDiscordConnectionUpdate',
)(function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
  if (tokens.length < 1) return yield* missingUpdateFieldError(all)
  const connectionId = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodePlatformConnectionId),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const state: ParsedDiscordConnectionUpdateState = {
    action: { type: 'config-discord-connection-update', connectionId },
    seen: new Set(),
  }
  let index = 1
  while (index < tokens.length) {
    const flag = tokens[index]
    const respondToGlobalMentions =
      flag === '--respond-to-global-mentions'
        ? true
        : flag === '--no-respond-to-global-mentions'
          ? false
          : undefined
    if (respondToGlobalMentions !== undefined) {
      if (state.seen.has('respondToGlobalMentions')) return yield* discordArgumentsError(all)
      state.action.respondToGlobalMentions = respondToGlobalMentions
      state.seen.add('respondToGlobalMentions')
      index += 1
      continue
    }
    const field = connectionUpdateField(flag)
    if (field === undefined) return yield* discordArgumentsError(all)
    yield* setDiscordConnectionUpdateField(state, field, tokens[index + 1], all)
    index += 2
  }
  if (state.seen.size === 0) return yield* missingUpdateFieldError(all)
  return state.action
})

export const parseConfigDiscordConnectionAdd = Effect.fn('Cli.parseConfigDiscordConnectionAdd')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    const connectionId = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodePlatformConnectionId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    let name: string | undefined
    let applicationId: DiscordSnowflake | undefined
    let publicKey: DiscordPublicKey | undefined
    let botTokenEnv: BotTokenEnvName | undefined
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
  },
)

export const parseConfigDiscordConnectionRemove = Effect.fn(
  'Cli.parseConfigDiscordConnectionRemove',
)(function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
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
})

export const parseConnectionEnableDisable = (enable: boolean) =>
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

export const parseConfigDiscordConnectionGet = Effect.fn('Cli.parseConfigDiscordConnectionGet')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length < 1 || tokens.length > 2) return yield* discordArgumentsError(all)
    const connectionId = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodePlatformConnectionId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    const json = yield* parseTrailingJson(tokens.slice(1), all)
    return { type: 'config-discord-connection-get' as const, connectionId, json }
  },
)

const decodeSlackTokenEnvName = Schema.decodeUnknownEffect(SlackTokenEnvName)
const decodeSlackChannelId = Schema.decodeUnknownEffect(SlackChannelId)
const decodeSlackSubjectId = Schema.decodeUnknownEffect(
  Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
)

/**
 * Parses a Slack permission policy argument: `all`, `allow=<id>[,<id>...]`, or
 * `deny=<id>[,<id>...]`. Slack ids are opaque non-empty tokens (team, channel,
 * or user ids), unlike Discord snowflakes.
 */
export const parseSlackAccessPolicySpec = (
  spec: string,
): Effect.Effect<AccessPolicy, FridayCliError> =>
  Effect.gen(function* () {
    if (spec === 'all') return { mode: 'all', ids: [] }
    const match = /^(allow|deny)=(.*)$/.exec(spec)
    if (match === null || match[2] === undefined || match[2] === '') {
      return yield* new FridayCliError({ argument: spec })
    }
    const ids = yield* Effect.forEach(match[2].split(','), (id) =>
      decodeSlackSubjectId(id.trim()).pipe(
        Effect.mapError(() => new FridayCliError({ argument: spec })),
      ),
    )
    // SAFETY: the regex above only matches the 'allow' or 'deny' alternatives.
    return { mode: match[1] as 'allow' | 'deny', ids: [...ids] }
  })

export const parseConfigSlackConnectionList = Effect.fn('Cli.parseConfigSlackConnectionList')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    const json = yield* parseTrailingJson(tokens, all)
    return { type: 'config-slack-connection-list' as const, json }
  },
)

export const parseConfigSlackConnectionAdd = Effect.fn('Cli.parseConfigSlackConnectionAdd')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    const connectionId = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodePlatformConnectionId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    let name: string | undefined
    let botTokenEnv: SlackTokenEnvName | undefined
    let appTokenEnv: SlackTokenEnvName | undefined
    let defaultReplyMode: ReplyModeType = 'reply-in-thread'
    let index = 1
    while (index < tokens.length) {
      const flag = tokens[index]
      if (flag === '--reply-in-thread' || flag === '--reply-in-channel') {
        defaultReplyMode = flag === '--reply-in-thread' ? 'reply-in-thread' : 'reply-in-channel'
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
      if (flag === '--bot-token-env') {
        if (botTokenEnv !== undefined) return yield* discordArgumentsError(all)
        botTokenEnv = yield* connectionFlagValue(value, all).pipe(
          Effect.flatMap(decodeSlackTokenEnvName),
          Effect.mapError(() => discordArgumentsError(all)),
        )
        index += 2
        continue
      }
      if (flag === '--app-token-env') {
        if (appTokenEnv !== undefined) return yield* discordArgumentsError(all)
        appTokenEnv = yield* connectionFlagValue(value, all).pipe(
          Effect.flatMap(decodeSlackTokenEnvName),
          Effect.mapError(() => discordArgumentsError(all)),
        )
        index += 2
        continue
      }
      return yield* discordArgumentsError(all)
    }
    if (name === undefined || botTokenEnv === undefined || appTokenEnv === undefined) {
      return yield* discordArgumentsError(all)
    }
    return {
      type: 'config-slack-connection-add' as const,
      connectionId,
      name,
      botTokenEnv,
      appTokenEnv,
      defaultReplyMode,
    }
  },
)

export const parseSlackTokenEnvFlag = Effect.fn('Cli.parseSlackTokenEnvFlag')(function* (
  current: SlackTokenEnvName | undefined,
  value: string | undefined,
  all: ReadonlyArray<string>,
) {
  if (current !== undefined) return yield* discordArgumentsError(all)
  return yield* connectionFlagValue(value, all).pipe(
    Effect.flatMap(decodeSlackTokenEnvName),
    Effect.mapError(() => discordArgumentsError(all)),
  )
})

/** Mutable assembly shape for the Slack connection update parsed from CLI flags. */
interface ParsedSlackConnectionUpdate {
  name?: string
  botTokenEnv?: SlackTokenEnvName
  appTokenEnv?: SlackTokenEnvName
  defaultReplyMode?: ReplyModeType
}

export const parseConfigSlackConnectionUpdate = Effect.fn('Cli.parseConfigSlackConnectionUpdate')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length < 2) {
      return yield* new FridayCliError({
        argument: all.join(' '),
        detail:
          'Provide at least one field to update: --name, --bot-token-env, --app-token-env, --reply-in-thread, or --reply-in-channel.',
      })
    }
    const connectionId = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodePlatformConnectionId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    let name: string | undefined
    let botTokenEnv: SlackTokenEnvName | undefined
    let appTokenEnv: SlackTokenEnvName | undefined
    let defaultReplyMode: ReplyModeType | undefined
    let index = 1
    while (index < tokens.length) {
      const flag = tokens[index]
      if (flag === '--reply-in-thread' || flag === '--reply-in-channel') {
        if (defaultReplyMode !== undefined) return yield* discordArgumentsError(all)
        defaultReplyMode = flag === '--reply-in-thread' ? 'reply-in-thread' : 'reply-in-channel'
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
      if (flag === '--bot-token-env') {
        botTokenEnv = yield* parseSlackTokenEnvFlag(botTokenEnv, value, all)
        index += 2
        continue
      }
      if (flag === '--app-token-env') {
        appTokenEnv = yield* parseSlackTokenEnvFlag(appTokenEnv, value, all)
        index += 2
        continue
      }
      return yield* discordArgumentsError(all)
    }
    if (
      name === undefined &&
      botTokenEnv === undefined &&
      appTokenEnv === undefined &&
      defaultReplyMode === undefined
    ) {
      return yield* discordArgumentsError(all)
    }
    const patch: ParsedSlackConnectionUpdate = {}
    if (name !== undefined) patch.name = name
    if (botTokenEnv !== undefined) patch.botTokenEnv = botTokenEnv
    if (appTokenEnv !== undefined) patch.appTokenEnv = appTokenEnv
    if (defaultReplyMode !== undefined) patch.defaultReplyMode = defaultReplyMode
    return {
      type: 'config-slack-connection-update' as const,
      connectionId,
      ...patch,
    }
  },
)

export const parseConfigSlackConnectionRemove = Effect.fn('Cli.parseConfigSlackConnectionRemove')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length !== 2 || tokens[1] !== '--yes') {
      return yield* discordArgumentsError(all)
    }
    const connectionId = yield* decodePlatformConnectionId(tokens[0] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
    return {
      type: 'config-slack-connection-remove' as const,
      connectionId,
      yes: true,
    }
  },
)

export const parseSlackConnectionEnableDisable = (enable: boolean) =>
  Effect.fn('Cli.parseSlackConnectionEnableDisable')(function* (
    tokens: ReadonlyArray<string>,
    all: ReadonlyArray<string>,
  ) {
    if (tokens.length !== 1) return yield* discordArgumentsError(all)
    const connectionId = yield* decodePlatformConnectionId(tokens[0] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
    return {
      type: enable
        ? ('config-slack-connection-enable' as const)
        : ('config-slack-connection-disable' as const),
      connectionId,
    }
  })

export const parseConfigSlackConnectionGet = Effect.fn('Cli.parseConfigSlackConnectionGet')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length < 1 || tokens.length > 2) return yield* discordArgumentsError(all)
    const connectionId = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodePlatformConnectionId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    const json = yield* parseTrailingJson(tokens.slice(1), all)
    return { type: 'config-slack-connection-get' as const, connectionId, json }
  },
)

export const parseConfigSlackAccessSet = (subject: SlackAccessSubject) =>
  Effect.fn('Cli.parseConfigSlackAccessSet')(function* (
    tokens: ReadonlyArray<string>,
    all: ReadonlyArray<string>,
  ) {
    if (tokens.length !== 2) return yield* discordArgumentsError(all)
    const connectionId = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodePlatformConnectionId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    const policy = yield* parseSlackAccessPolicySpec(tokens[1] ?? '')
    return { type: 'config-slack-access-set' as const, connectionId, subject, policy }
  })

export const parseConfigSlackChannelSet = Effect.fn('Cli.parseConfigSlackChannelSet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  if (tokens.length < 3) return yield* discordArgumentsError(all)
  const connectionId = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodePlatformConnectionId),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  const channelId = yield* decodeSlackChannelId(tokens[1] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  // A bare reply mode keeps the original positional form working; the flags
  // set either override without ambiguity.
  let invocationMode: InvocationModeType | undefined
  let replyMode: ReplyModeType | undefined
  let index = 2
  while (index < tokens.length) {
    const flag = tokens[index]
    if (flag === '--reply-in-thread' || flag === '--reply-in-channel') {
      if (replyMode !== undefined) return yield* discordArgumentsError(all)
      replyMode = flag === '--reply-in-thread' ? 'reply-in-thread' : 'reply-in-channel'
      index += 1
      continue
    }
    if (flag === '--invocation') {
      const value = tokens[index + 1]
      if (invocationMode !== undefined || value === undefined) {
        return yield* discordArgumentsError(all)
      }
      invocationMode = yield* decodeInvocationMode(value).pipe(
        Effect.mapError(() => discordArgumentsError(all)),
      )
      index += 2
      continue
    }
    if (flag === 'reply-in-thread' || flag === 'reply-in-channel') {
      if (replyMode !== undefined) return yield* discordArgumentsError(all)
      replyMode = flag
      index += 1
      continue
    }
    return yield* discordArgumentsError(all)
  }
  if (invocationMode === undefined && replyMode === undefined) {
    // A channel set with no overrides would be a no-op row.
    return yield* discordArgumentsError(all)
  }
  return {
    type: 'config-slack-channel-set' as const,
    connectionId,
    channelId,
    patch: buildSlackChannelPatch(invocationMode, replyMode),
  }
})

/** Builds a Slack channel patch carrying only the overrides present on the command line. */
interface ParsedSlackChannelPatch {
  invocationMode?: InvocationModeType
  replyMode?: ReplyModeType
}

const buildSlackChannelPatch = (
  invocationMode: InvocationModeType | undefined,
  replyMode: ReplyModeType | undefined,
): SlackChannelPatch => {
  const patch: ParsedSlackChannelPatch = {}
  if (invocationMode !== undefined) patch.invocationMode = invocationMode
  if (replyMode !== undefined) patch.replyMode = replyMode
  return patch
}

export const parseConfigSlackChannelReset = Effect.fn('Cli.parseConfigSlackChannelReset')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length !== 2) return yield* discordArgumentsError(all)
    const connectionId = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodePlatformConnectionId),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    const channelId = yield* decodeSlackChannelId(tokens[1] ?? '').pipe(
      Effect.mapError(() => discordArgumentsError(all)),
    )
    return { type: 'config-slack-channel-reset' as const, connectionId, channelId }
  },
)

export const parseConnectionGuild = Effect.fn('Cli.parseConnectionGuild')(function* (
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

export const parseConfigDiscordGuildEnable = Effect.fn('Cli.parseConfigDiscordGuildEnable')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length !== 2) return yield* discordArgumentsError(all)
    const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
    return { type: 'config-discord-guild-enable' as const, connectionId, guildId }
  },
)

export const parseConfigDiscordGuildDisable = Effect.fn('Cli.parseConfigDiscordGuildDisable')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length !== 2) return yield* discordArgumentsError(all)
    const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
    return { type: 'config-discord-guild-disable' as const, connectionId, guildId }
  },
)

export const parseConfigDiscordGuildRemove = Effect.fn('Cli.parseConfigDiscordGuildRemove')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length === 2) return yield* guildRemoveConfirmationError(all)
    if (tokens.length !== 3 || tokens[2] !== '--yes') {
      return yield* discordArgumentsError(all)
    }
    const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
    return { type: 'config-discord-guild-remove' as const, connectionId, guildId, yes: true }
  },
)

export const parseConfigDiscordGuildList = Effect.fn('Cli.parseConfigDiscordGuildList')(function* (
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

export const parseConfigDiscordGuildSetInvocation = Effect.fn(
  'Cli.parseConfigDiscordGuildSetInvocation',
)(function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
  if (tokens.length !== 3) return yield* discordArgumentsError(all)
  const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
  const mode = yield* decodeInvocationMode(tokens[2] ?? '').pipe(
    Effect.mapError(() => discordArgumentsError(all)),
  )
  return { type: 'config-discord-guild-set-invocation' as const, connectionId, guildId, mode }
})

export const parseConfigDiscordGuildSetUsers = Effect.fn('Cli.parseConfigDiscordGuildSetUsers')(
  function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
    if (tokens.length !== 3) return yield* discordArgumentsError(all)
    const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
    const policy = yield* parseAccessPolicySpec(tokens[2] ?? '')
    return { type: 'config-discord-guild-set-users' as const, connectionId, guildId, policy }
  },
)

export const parseConfigDiscordGuildSetChannels = Effect.fn(
  'Cli.parseConfigDiscordGuildSetChannels',
)(function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
  if (tokens.length !== 3) return yield* discordArgumentsError(all)
  const { connectionId, guildId } = yield* parseConnectionGuild(tokens, 0, 1, all)
  const policy = yield* parseAccessPolicySpec(tokens[2] ?? '')
  return { type: 'config-discord-guild-set-channels' as const, connectionId, guildId, policy }
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

export const parseConfigDiscordGuildChannelReset = Effect.fn(
  'Cli.parseConfigDiscordGuildChannelReset',
)(function* (tokens: ReadonlyArray<string>, all: ReadonlyArray<string>) {
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
})

export const parseConfigDiscordGuildChannelSet = Effect.fn('Cli.parseConfigDiscordGuildChannelSet')(
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

type WorktreeEnsureAction = Extract<FridayCliAction, { readonly type: 'worktree-ensure' }>

const buildWorktreeEnsureAction = (
  url: RepositoryUrl,
  workspace: string | undefined,
  ref: string | undefined,
  branch: string | undefined,
  json: boolean,
): WorktreeEnsureAction => {
  let action: WorktreeEnsureAction = { type: 'worktree-ensure', url, json }
  if (workspace !== undefined) action = { ...action, workspace }
  if (ref !== undefined) action = { ...action, ref }
  if (branch !== undefined) action = { ...action, branch }
  return action
}

export const parseWorktreeEnsure = Effect.fn('Cli.parseWorktreeEnsure')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const url = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeRepositoryUrl),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  let workspace: string | undefined
  let ref: string | undefined
  let branch: string | undefined
  let json = false
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = tokens[index]
    if (flag === '--json') {
      json = true
      continue
    }
    if (flag === '--workspace' || flag === '--ref' || flag === '--branch') {
      const value = tokens[index + 1]
      if (!value || value.startsWith('-')) {
        return yield* discordArgumentsError(all)
      }
      if (flag === '--workspace') workspace = value
      else if (flag === '--ref') ref = value
      else branch = value
      index += 1
      continue
    }
    return yield* discordArgumentsError(all)
  }
  return buildWorktreeEnsureAction(url, workspace, ref, branch, json)
})

export const parseWorktreeList = Effect.fn('Cli.parseWorktreeList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'worktree-list' as const, json }
})

export const parseWorkspaceCleanupApply = Effect.fn('Cli.parseWorkspaceCleanupApply')(function* (
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

export const parseWorkspaceCleanupList = Effect.fn('Cli.parseWorkspaceCleanupList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'workspace-cleanup-list' as const, json }
})

type DocumentSaveAction = Extract<FridayCliAction, { readonly type: 'document-save' }>

const buildDocumentSaveAction = (
  key: DocumentKey,
  format: DocumentFormat,
  file: string | undefined,
  json: boolean,
): DocumentSaveAction => {
  let action: DocumentSaveAction = { type: 'document-save', key, format, json }
  if (file !== undefined) action = { ...action, file }
  return action
}

export const parseDocumentSave = Effect.fn('Cli.parseDocumentSave')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const key = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeDocumentKey),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  let format: DocumentFormat = 'markdown'
  let file: string | undefined
  let json = false
  for (let index = 1; index < tokens.length; index += 1) {
    const flag = tokens[index]
    if (flag === '--json') {
      json = true
      continue
    }
    if (flag === '--format' || flag === '--file') {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('-')) {
        return yield* discordArgumentsError(all)
      }
      if (flag === '--format') {
        if (value !== 'markdown' && value !== 'html') {
          return yield* discordArgumentsError(all)
        }
        format = value
      } else {
        file = value
      }
      index += 1
      continue
    }
    return yield* discordArgumentsError(all)
  }
  return buildDocumentSaveAction(key, format, file, json)
})

export const parseDocumentKeyJson = <
  const Type extends 'document-get' | 'document-url' | 'document-revoke',
>(
  type: Type,
) =>
  Effect.fn('Cli.parseDocumentKeyJson')(function* (
    tokens: ReadonlyArray<string>,
    all: ReadonlyArray<string>,
  ) {
    const key = yield* positionalToken(tokens, 0, all).pipe(
      Effect.flatMap(decodeDocumentKey),
      Effect.mapError(() => discordArgumentsError(all)),
    )
    const json = yield* parseTrailingJson(tokens.slice(1), all)
    return { type, key, json }
  })

export const parseDocumentGet = parseDocumentKeyJson('document-get')
export const parseDocumentUrl = parseDocumentKeyJson('document-url')
export const parseDocumentRevoke = parseDocumentKeyJson('document-revoke')

export const parseDocumentList = Effect.fn('Cli.parseDocumentList')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const json = yield* parseTrailingJson(tokens, all)
  return { type: 'document-list' as const, json }
})

export const parseDocumentConfigGet = Effect.fn('Cli.parseDocumentConfigGet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  return { type: 'config-document-get' as const, json: yield* parseTrailingJson(tokens, all) }
})

export const parseDocumentConfigSet = Effect.fn('Cli.parseDocumentConfigSet')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  let patch: DocumentConfigPatch = {}
  let json = false
  for (let index = 0; index < tokens.length; index += 1) {
    const flag = tokens[index]
    if (flag === '--json') {
      json = true
      continue
    }
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('-')) return yield* discordArgumentsError(all)
    if (flag === '--public-base-url') patch = { ...patch, publicBaseUrl: value }
    else if (flag === '--listen-host') patch = { ...patch, listenHost: value }
    else if (flag === '--listen-port' || flag === '--max-bytes') {
      const number = Number(value)
      if (!Number.isInteger(number)) return yield* discordArgumentsError(all)
      patch =
        flag === '--listen-port' ? { ...patch, listenPort: number } : { ...patch, maxBytes: number }
    } else return yield* discordArgumentsError(all)
    index += 1
  }
  if (Object.keys(patch).length === 0) return yield* discordArgumentsError(all)
  return { type: 'config-document-set' as const, patch, json }
})

export const parseDocumentRemove = Effect.fn('Cli.parseDocumentRemove')(function* (
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
) {
  const key = yield* positionalToken(tokens, 0, all).pipe(
    Effect.flatMap(decodeDocumentKey),
    Effect.mapError(() => discordArgumentsError(all)),
  )
  if (tokens.length !== 2 || tokens[1] !== '--yes') return yield* discordArgumentsError(all)
  return { type: 'document-remove' as const, key, yes: true }
})
