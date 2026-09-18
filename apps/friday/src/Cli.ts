import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { PlatformConnectionId, SubagentProfileName } from '@friday/contracts/conversation'

import {
  type AccessPolicy,
  type DiscordGuildConfig,
  type InvocationMode as InvocationModeType,
} from './config/AppConfig.ts'
import {
  DiscordGuildChannelId,
  DiscordGuildId,
  type DiscordGuildChannelPatch,
  type DiscordGuildChannelResetOutcome,
  type DiscordGuildChannelUpdateOutcome,
  type DiscordGuildDisableOutcome,
  type DiscordGuildEnableOutcome,
  type DiscordGuildRemoveOutcome,
  type DiscordGuildUpdateOutcome,
} from './config/DiscordGuilds.ts'
import {
  type DiscordConnectionAddOutcome,
  type DiscordConnectionDetail,
  type DiscordConnectionDisableOutcome,
  type DiscordConnectionEnableOutcome,
  type DiscordConnectionRecord,
  type DiscordConnectionRemoveOutcome,
  type DiscordConnectionUpdateOutcome,
} from './config/DiscordConnections.ts'
import {
  SlackChannelId,
  type SlackAccessSubject,
  type SlackAccessUpdateOutcome,
  type SlackChannelPatch,
  type SlackChannelResetOutcome,
  type SlackChannelUpdateOutcome,
  type SlackConnectionAddOutcome,
  type SlackConnectionDetail,
  type SlackConnectionDisableOutcome,
  type SlackConnectionEnableOutcome,
  type SlackConnectionRecord,
  type SlackConnectionRemoveOutcome,
  type SlackConnectionUpdateOutcome,
} from './config/SlackConnections.ts'
import { ControlSocketError, isControlSocketNotRunning } from './control/ControlSocket.ts'
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
  type RootUser,
  type RootUserAddOutcome,
  type RootUserRemoveOutcome,
} from './config/RootUsers.ts'
import { IdentityText, type IdentityTextSetOutcome } from './config/IdentityConfiguration.ts'
import {
  type ManagedWorktree,
  type ManagedWorktreeListEntry,
} from './repositories/RepositoryWorktrees.ts'
import {
  ConfiguredModelSelection,
  FixedModelName,
  StoredSubagentProfile,
  type FixedModelSetOutcome,
  type SubagentProfileAddOutcome,
  type SubagentProfileRemoveOutcome,
  type SubagentProfileUpdateOutcome,
} from './config/ModelConfiguration.ts'
import type { PiCatalogModel } from './harness/pi/PiModelCatalog.ts'
import { type WorkspaceCleanupProposal } from './workspaces/WorkspaceCleanup.ts'
import {
  DocumentKey,
  type DocumentConfig,
  type DocumentConfigPatch,
  type DocumentFormat,
  type DocumentMetadata,
  type SavedDocument,
  type StoredDocument,
} from './documents/Documents.ts'
import { ConfigReloadRejectedError, FridayCliError, type FridayCliAction } from './cli/Types.ts'
import { isControlSocketError, type PiModelListOptions } from './cli/Parsing.ts'
import { parseFridayCli, renderCliHelp } from './cli/CommandTree.ts'
import {
  renderConfiguredModels,
  renderSubagentProfiles,
  renderPiModels,
  renderPiModel,
  renderCleanup,
  renderWorktreeList,
  renderDocumentList,
  renderDocumentConfig,
  renderWorkspaceCleanupList,
  formatDiscordAdminAdd,
  formatDiscordAdminRemove,
  renderDiscordAdminList,
  formatRootUserAdd,
  formatRootUserRemove,
  renderRootUserList,
  renderDiscordConnectionList,
  renderDiscordConnectionDetail,
  formatDiscordConnectionAdd,
  formatDiscordConnectionUpdate,
  formatDiscordConnectionRemove,
  formatDiscordConnectionEnable,
  formatDiscordConnectionDisable,
  renderSlackConnectionList,
  renderSlackConnectionDetail,
  formatSlackConnectionAdd,
  formatSlackConnectionUpdate,
  formatSlackConnectionRemove,
  formatSlackConnectionEnable,
  formatSlackConnectionDisable,
  formatSlackAccessSet,
  formatSlackChannelSet,
  formatSlackChannelReset,
  renderDiscordGuildList,
  applyDiscordConfigMutation,
  formatDiscordConfigMutation,
  formatDiscordGuildEnable,
  formatDiscordGuildDisable,
  formatDiscordGuildRemove,
  formatDiscordGuildInvocation,
  formatDiscordGuildUsers,
  formatDiscordGuildChannels,
  formatDiscordGuildChannelSet,
  formatDiscordGuildChannelReset,
  renderWorktree,
} from './cli/Rendering.ts'

export { ConfigReloadRejectedError, FridayCliError, type FridayCliAction } from './cli/Types.ts'
export { parseAccessPolicySpec, parseSlackAccessPolicySpec } from './cli/Parsing.ts'
export {
  cliCommandSpec,
  findCommandSpec,
  parseFridayCli,
  renderCliHelp,
} from './cli/CommandTree.ts'
export {
  applyDiscordConfigMutation,
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
  formatRootUserAdd,
  formatRootUserRemove,
  formatSlackAccessSet,
  formatSlackChannelReset,
  formatSlackChannelSet,
  formatSlackConnectionAdd,
  formatSlackConnectionDisable,
  formatSlackConnectionEnable,
  formatSlackConnectionRemove,
  formatSlackConnectionUpdate,
  groupWorktreesByRepository,
  renderConfiguredModels,
  renderDiscordAdminList,
  renderDiscordConnectionDetail,
  renderDiscordConnectionList,
  renderDiscordGuildList,
  renderDocumentConfig,
  renderDocumentList,
  renderPiModels,
  renderRootUserList,
  renderSlackConnectionDetail,
  renderSlackConnectionList,
  renderSubagentProfiles,
  renderWorkspaceCleanupList,
  renderWorktreeList,
  type DiscordConfigApplicationOutcome,
  type DiscordConfigMutationResult,
  type WorktreeRepositoryGroup,
} from './cli/Rendering.ts'
export {
  isCliBranch,
  isCliRemoved,
  type CliBranchSpec,
  type CliCommandSpec,
  type CliLeafSpec,
  type CliRemovedSpec,
} from './cli/Command.ts'

export const FRIDAY_VERSION = '0.0.0-nightly.43'

export type FridayCliOperations<
  E,
  WorktreeError,
  CleanupError,
  GuildError,
  AdminError,
  RootUserError,
  IdentityConfigurationError,
  ConnectionError,
  ModelConfigError,
  ModelCatalogError,
  DocumentError,
  SlackError = never,
> = {
  readonly start: Effect.Effect<never, E>
  readonly reloadConfig: Effect.Effect<ConfigReloadOutcomeType, ControlSocketError>
  readonly listConfiguredModels: () => Effect.Effect<
    ReadonlyArray<ConfiguredModelSelection>,
    ModelConfigError
  >
  readonly getConfiguredModel: (
    name: FixedModelName,
  ) => Effect.Effect<ConfiguredModelSelection, ModelConfigError>
  readonly setConfiguredModel: (
    selection: ConfiguredModelSelection,
  ) => Effect.Effect<FixedModelSetOutcome, ModelConfigError>
  readonly listSubagentProfiles: () => Effect.Effect<
    ReadonlyArray<StoredSubagentProfile>,
    ModelConfigError
  >
  readonly getSubagentProfile: (
    name: SubagentProfileName,
  ) => Effect.Effect<Option.Option<StoredSubagentProfile>, ModelConfigError>
  readonly addSubagentProfile: (
    profile: StoredSubagentProfile,
  ) => Effect.Effect<SubagentProfileAddOutcome, ModelConfigError>
  readonly updateSubagentProfile: (
    patch: Extract<FridayCliAction, { readonly type: 'config-profile-update' }>['patch'],
  ) => Effect.Effect<SubagentProfileUpdateOutcome, ModelConfigError>
  readonly removeSubagentProfile: (
    name: SubagentProfileName,
  ) => Effect.Effect<SubagentProfileRemoveOutcome, ModelConfigError>
  readonly listPiModels: (options: {
    readonly provider?: string
    readonly availableOnly?: boolean
  }) => Effect.Effect<ReadonlyArray<PiCatalogModel>, ModelCatalogError>
  readonly getPiModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<PiCatalogModel | undefined, ModelCatalogError>
  readonly reloadPiModels: () => Effect.Effect<number, ModelCatalogError>
  readonly addDiscordAdmin: (
    userId: DiscordUserId,
  ) => Effect.Effect<DiscordAdminAddOutcome, AdminError>
  readonly removeDiscordAdmin: (
    userId: DiscordUserId,
  ) => Effect.Effect<DiscordAdminRemoveOutcome, AdminError>
  readonly listDiscordAdmins: () => Effect.Effect<ReadonlyArray<string>, AdminError>
  readonly addRootUser: (rootUser: RootUser) => Effect.Effect<RootUserAddOutcome, RootUserError>
  readonly removeRootUser: (
    rootUser: RootUser,
  ) => Effect.Effect<RootUserRemoveOutcome, RootUserError>
  readonly listRootUsers: () => Effect.Effect<ReadonlyArray<RootUser>, RootUserError>
  readonly getIdentityText: () => Effect.Effect<IdentityText, IdentityConfigurationError>
  readonly setIdentityText: (
    text: IdentityText,
  ) => Effect.Effect<IdentityTextSetOutcome, IdentityConfigurationError>
  readonly addDiscordConnection: (
    input: Extract<FridayCliAction, { readonly type: 'config-discord-connection-add' }>,
  ) => Effect.Effect<DiscordConnectionAddOutcome, ConnectionError>
  readonly updateDiscordConnection: (
    action: Extract<FridayCliAction, { readonly type: 'config-discord-connection-update' }>,
  ) => Effect.Effect<DiscordConnectionUpdateOutcome, ConnectionError>
  readonly removeDiscordConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<DiscordConnectionRemoveOutcome, ConnectionError>
  readonly enableDiscordConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<DiscordConnectionEnableOutcome, ConnectionError>
  readonly disableDiscordConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<DiscordConnectionDisableOutcome, ConnectionError>
  readonly getDiscordConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<Option.Option<DiscordConnectionDetail>, ConnectionError>
  readonly listDiscordConnections: () => Effect.Effect<
    ReadonlyArray<DiscordConnectionRecord>,
    ConnectionError
  >
  readonly listDiscordGuilds: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<ReadonlyArray<DiscordGuildConfig>, GuildError>
  readonly enableDiscordGuild: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
  ) => Effect.Effect<DiscordGuildEnableOutcome, GuildError>
  readonly disableDiscordGuild: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
  ) => Effect.Effect<DiscordGuildDisableOutcome, GuildError>
  readonly removeDiscordGuild: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
  ) => Effect.Effect<DiscordGuildRemoveOutcome, GuildError>
  readonly setDiscordGuildInvocation: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    mode: InvocationModeType,
  ) => Effect.Effect<DiscordGuildUpdateOutcome, GuildError>
  readonly setDiscordGuildUsers: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    policy: AccessPolicy,
  ) => Effect.Effect<DiscordGuildUpdateOutcome, GuildError>
  readonly setDiscordGuildChannels: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    policy: AccessPolicy,
  ) => Effect.Effect<DiscordGuildUpdateOutcome, GuildError>
  readonly setDiscordGuildChannel: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    channelId: DiscordGuildChannelId,
    patch: DiscordGuildChannelPatch,
  ) => Effect.Effect<DiscordGuildChannelUpdateOutcome, GuildError>
  readonly resetDiscordGuildChannel: (
    connectionId: PlatformConnectionId,
    guildId: DiscordGuildId,
    channelId: DiscordGuildChannelId,
  ) => Effect.Effect<DiscordGuildChannelResetOutcome, GuildError>
  readonly addSlackConnection: (
    input: Extract<FridayCliAction, { readonly type: 'config-slack-connection-add' }>,
  ) => Effect.Effect<SlackConnectionAddOutcome, SlackError>
  readonly updateSlackConnection: (
    action: Extract<FridayCliAction, { readonly type: 'config-slack-connection-update' }>,
  ) => Effect.Effect<SlackConnectionUpdateOutcome, SlackError>
  readonly removeSlackConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<SlackConnectionRemoveOutcome, SlackError>
  readonly enableSlackConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<SlackConnectionEnableOutcome, SlackError>
  readonly disableSlackConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<SlackConnectionDisableOutcome, SlackError>
  readonly getSlackConnection: (
    connectionId: PlatformConnectionId,
  ) => Effect.Effect<Option.Option<SlackConnectionDetail>, SlackError>
  readonly listSlackConnections: () => Effect.Effect<
    ReadonlyArray<SlackConnectionRecord>,
    SlackError
  >
  readonly setSlackAccess: (
    connectionId: PlatformConnectionId,
    subject: SlackAccessSubject,
    policy: AccessPolicy,
  ) => Effect.Effect<SlackAccessUpdateOutcome, SlackError>
  readonly setSlackChannel: (
    connectionId: PlatformConnectionId,
    channelId: SlackChannelId,
    patch: SlackChannelPatch,
  ) => Effect.Effect<SlackChannelUpdateOutcome, SlackError>
  readonly resetSlackChannel: (
    connectionId: PlatformConnectionId,
    channelId: SlackChannelId,
  ) => Effect.Effect<SlackChannelResetOutcome, SlackError>
  readonly ensureWorktree: (
    action: Extract<FridayCliAction, { readonly type: 'worktree-ensure' }>,
  ) => Effect.Effect<ManagedWorktree, WorktreeError>
  readonly listWorktrees: () => Effect.Effect<
    ReadonlyArray<ManagedWorktreeListEntry>,
    WorktreeError
  >
  readonly readDocumentContent: (file: string | undefined) => Effect.Effect<string, DocumentError>
  readonly saveDocument: (
    key: DocumentKey,
    format: DocumentFormat,
    content: string,
  ) => Effect.Effect<SavedDocument, DocumentError>
  readonly getDocument: (
    key: DocumentKey,
  ) => Effect.Effect<Option.Option<StoredDocument>, DocumentError>
  readonly listDocuments: () => Effect.Effect<ReadonlyArray<DocumentMetadata>, DocumentError>
  readonly getDocumentUrl: (key: DocumentKey) => Effect.Effect<Option.Option<string>, DocumentError>
  readonly revokeDocument: (
    key: DocumentKey,
  ) => Effect.Effect<Option.Option<SavedDocument>, DocumentError>
  readonly removeDocument: (key: DocumentKey) => Effect.Effect<'removed' | 'missing', DocumentError>
  readonly getDocumentConfig: () => Effect.Effect<DocumentConfig, DocumentError>
  readonly updateDocumentConfig: (
    patch: DocumentConfigPatch,
  ) => Effect.Effect<DocumentConfig, DocumentError>
  readonly applyWorkspaceCleanup: (
    action: Extract<FridayCliAction, { readonly type: 'workspace-cleanup-apply' }>,
    currentWorkingDirectory: string,
  ) => Effect.Effect<WorkspaceCleanupProposal, CleanupError>
  readonly listWorkspaceCleanupProposals: () => Effect.Effect<
    ReadonlyArray<WorkspaceCleanupProposal>,
    CleanupError
  >
}

type ProfileAction = Extract<FridayCliAction, { readonly type: `config-profile-${string}` }>
type ConnectionAction = Extract<
  FridayCliAction,
  {
    readonly type: `config-discord-connection-${string}` | `config-slack-connection-${string}`
  }
>
type ConfigurationAction = Extract<
  FridayCliAction,
  {
    readonly type:
      | 'help'
      | 'version'
      | 'config-reload'
      | 'config-model-list'
      | 'config-model-get'
      | 'config-model-set'
      | 'config-identity-get'
      | 'config-identity-set'
      | ProfileAction['type']
  }
>
type CatalogAction = Extract<
  FridayCliAction,
  {
    readonly type:
      | 'model-list'
      | 'model-get'
      | 'model-reload'
      | 'config-admin-discord-add'
      | 'config-admin-discord-remove'
      | 'config-admin-discord-list'
      | 'config-root-user-add'
      | 'config-root-user-remove'
      | 'config-root-user-list'
      | ConnectionAction['type']
  }
>
type GuildAction = Extract<
  FridayCliAction,
  {
    readonly type:
      | `config-discord-guild-${string}`
      | `config-slack-access-${string}`
      | `config-slack-channel-${string}`
  }
>
type RuntimeAction = Exclude<FridayCliAction, ConfigurationAction | CatalogAction | GuildAction>
type GroupFor<ActionType extends FridayCliAction['type']> =
  ActionType extends ConfigurationAction['type']
    ? 'configuration'
    : ActionType extends CatalogAction['type']
      ? 'catalog'
      : ActionType extends GuildAction['type']
        ? 'guild'
        : 'runtime'

/** An exhaustive, type-checked action-to-handler assignment keeps each dispatcher small. */
const cliActionGroups = {
  help: 'configuration',
  version: 'configuration',
  'config-reload': 'configuration',
  'config-model-list': 'configuration',
  'config-model-get': 'configuration',
  'config-model-set': 'configuration',
  'config-identity-get': 'configuration',
  'config-identity-set': 'configuration',
  'config-profile-list': 'configuration',
  'config-profile-get': 'configuration',
  'config-profile-add': 'configuration',
  'config-profile-update': 'configuration',
  'config-profile-remove': 'configuration',
  'model-list': 'catalog',
  'model-get': 'catalog',
  'model-reload': 'catalog',
  'config-admin-discord-add': 'catalog',
  'config-admin-discord-remove': 'catalog',
  'config-admin-discord-list': 'catalog',
  'config-root-user-add': 'catalog',
  'config-root-user-remove': 'catalog',
  'config-root-user-list': 'catalog',
  'config-discord-connection-list': 'catalog',
  'config-discord-connection-add': 'catalog',
  'config-discord-connection-update': 'catalog',
  'config-discord-connection-remove': 'catalog',
  'config-discord-connection-enable': 'catalog',
  'config-discord-connection-disable': 'catalog',
  'config-discord-connection-get': 'catalog',
  'config-slack-connection-list': 'catalog',
  'config-slack-connection-add': 'catalog',
  'config-slack-connection-update': 'catalog',
  'config-slack-connection-remove': 'catalog',
  'config-slack-connection-enable': 'catalog',
  'config-slack-connection-disable': 'catalog',
  'config-slack-connection-get': 'catalog',
  'config-discord-guild-enable': 'guild',
  'config-discord-guild-disable': 'guild',
  'config-discord-guild-remove': 'guild',
  'config-discord-guild-list': 'guild',
  'config-discord-guild-set-invocation': 'guild',
  'config-discord-guild-set-users': 'guild',
  'config-discord-guild-set-channels': 'guild',
  'config-discord-guild-channel-set': 'guild',
  'config-discord-guild-channel-reset': 'guild',
  'config-slack-access-set': 'guild',
  'config-slack-channel-set': 'guild',
  'config-slack-channel-reset': 'guild',
  'workspace-cleanup-apply': 'runtime',
  'workspace-cleanup-list': 'runtime',
  'worktree-ensure': 'runtime',
  'worktree-list': 'runtime',
  'document-save': 'runtime',
  'document-get': 'runtime',
  'document-list': 'runtime',
  'document-url': 'runtime',
  'document-revoke': 'runtime',
  'document-remove': 'runtime',
  'config-document-get': 'runtime',
  'config-document-set': 'runtime',
  start: 'runtime',
} satisfies {
  readonly [ActionType in FridayCliAction['type']]: GroupFor<ActionType>
}

const isConfigurationAction = (action: FridayCliAction): action is ConfigurationAction =>
  cliActionGroups[action.type] === 'configuration'
const isProfileAction = (action: ConfigurationAction): action is ProfileAction =>
  action.type.startsWith('config-profile-')
const isCatalogAction = (action: FridayCliAction): action is CatalogAction =>
  cliActionGroups[action.type] === 'catalog'
const isConnectionAction = (action: CatalogAction): action is ConnectionAction =>
  action.type.startsWith('config-discord-connection-') ||
  action.type.startsWith('config-slack-connection-')
const isGuildAction = (action: FridayCliAction): action is GuildAction =>
  cliActionGroups[action.type] === 'guild'

type DocumentAction = Extract<
  FridayCliAction,
  { readonly type: `document-${string}` | `config-document-${string}` }
>
const isDocumentAction = (action: RuntimeAction): action is DocumentAction =>
  action.type.startsWith('document-') || action.type.startsWith('config-document-')

export const runFridayCli = <
  E,
  WorktreeError,
  CleanupError,
  GuildError,
  AdminError,
  RootUserError,
  IdentityConfigurationError,
  ConnectionError,
  ModelConfigError,
  ModelCatalogError,
  DocumentError,
  SlackError,
>(
  arguments_: ReadonlyArray<string>,
  options: FridayCliOperations<
    E,
    WorktreeError,
    CleanupError,
    GuildError,
    AdminError,
    RootUserError,
    IdentityConfigurationError,
    ConnectionError,
    ModelConfigError,
    ModelCatalogError,
    DocumentError,
    SlackError
  >,
): Effect.Effect<
  void,
  | FridayCliError
  | ConfigReloadRejectedError
  | E
  | WorktreeError
  | CleanupError
  | GuildError
  | ControlSocketError
  | AdminError
  | RootUserError
  | IdentityConfigurationError
  | ConnectionError
  | ModelConfigError
  | ModelCatalogError
  | DocumentError
  | SlackError
> =>
  Effect.gen(function* () {
    const action = yield* parseFridayCli(arguments_)
    const reloadAfterCommit = Effect.fn('Cli.reloadAfterCommit')(function* () {
      const result = yield* options.reloadConfig.pipe(
        Effect.map(Option.some),
        Effect.catch((cause) =>
          isControlSocketError(cause) && isControlSocketNotRunning(cause)
            ? Effect.succeed(Option.none())
            : Console.error(
                'Stored configuration change committed, but automatic reload failed.',
              ).pipe(Effect.andThen(Effect.fail(cause))),
        ),
      )
      if (Option.isNone(result)) {
        yield* Console.log(
          'No running Friday process accepted the reload. The next start will load the stored change.',
        )
        return
      }
      if (!result.value.ok) {
        yield* Console.error(
          'Stored configuration change committed, but the running Friday rejected the reload.',
        )
        return yield* new ConfigReloadRejectedError({ detail: result.value.detail })
      }
      yield* Console.log(formatConfigReloadOutcome(result.value))
    })
    const runConfigurationAction = Effect.fn('Cli.runConfigurationAction')(function* (
      selected: ConfigurationAction,
    ) {
      if (isProfileAction(selected)) return yield* runProfileAction(selected)
      switch (selected.type) {
        case 'help':
          yield* Console.log(renderCliHelp(selected.topic))
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
        case 'config-model-list': {
          const models = yield* options.listConfiguredModels()
          yield* Console.log(
            selected.json ? JSON.stringify(models) : renderConfiguredModels(models),
          )
          return
        }
        case 'config-model-get': {
          const model = yield* options.getConfiguredModel(selected.name)
          yield* Console.log(
            selected.json ? JSON.stringify(model) : renderConfiguredModels([model]),
          )
          return
        }
        case 'config-model-set': {
          const outcome = yield* options.setConfiguredModel(selected.selection)
          yield* Console.log(
            outcome === 'updated'
              ? `Friday ${selected.selection.name} model updated.`
              : `Friday ${selected.selection.name} model already has the requested selection.`,
          )
          if (outcome === 'updated') yield* reloadAfterCommit()
          return
        }
        case 'config-identity-get': {
          const identityText = yield* options.getIdentityText()
          yield* Console.log(selected.json ? JSON.stringify(identityText) : identityText)
          return
        }
        case 'config-identity-set': {
          const outcome = yield* options.setIdentityText(selected.text)
          yield* Console.log(
            outcome === 'updated'
              ? 'Identity text updated.'
              : 'Identity text already has the requested value.',
          )
          if (outcome === 'updated') yield* reloadAfterCommit()
          return
        }
        default: {
          const unhandled: never = selected
          return unhandled
        }
      }
    })
    const runProfileAction = Effect.fn('Cli.runProfileAction')(function* (selected: ProfileAction) {
      switch (selected.type) {
        case 'config-profile-list': {
          const profiles = yield* options.listSubagentProfiles()
          yield* Console.log(
            selected.json ? JSON.stringify(profiles) : renderSubagentProfiles(profiles),
          )
          return
        }
        case 'config-profile-get': {
          const profile = yield* options.getSubagentProfile(selected.name)
          yield* Console.log(
            Option.match(profile, {
              onNone: () =>
                selected.json ? 'null' : `Subagent profile ${selected.name} is not configured.`,
              onSome: (value) =>
                selected.json ? JSON.stringify(value) : renderSubagentProfiles([value]),
            }),
          )
          return
        }
        case 'config-profile-add': {
          const outcome = yield* options.addSubagentProfile(selected.profile)
          yield* Console.log(
            outcome === 'added'
              ? `Subagent profile ${selected.profile.name} added.`
              : `Subagent profile ${selected.profile.name} already exists.`,
          )
          if (outcome === 'added') yield* reloadAfterCommit()
          return
        }
        case 'config-profile-update': {
          const outcome = yield* options.updateSubagentProfile(selected.patch)
          yield* Console.log(
            outcome === 'updated'
              ? `Subagent profile ${selected.patch.name} updated.`
              : outcome === 'unchanged'
                ? `Subagent profile ${selected.patch.name} already has the requested configuration.`
                : `Subagent profile ${selected.patch.name} is not configured.`,
          )
          if (outcome === 'updated') yield* reloadAfterCommit()
          return
        }
        case 'config-profile-remove': {
          const outcome = yield* options.removeSubagentProfile(selected.name)
          yield* Console.log(
            outcome === 'removed'
              ? `Subagent profile ${selected.name} removed.`
              : outcome === 'protected'
                ? 'The subagent profile named primary is protected from removal; update it instead.'
                : `Subagent profile ${selected.name} is not configured.`,
          )
          if (outcome === 'removed') yield* reloadAfterCommit()
          return
        }
        default: {
          const unhandled: never = selected
          return unhandled
        }
      }
    })
    const runCatalogAction = Effect.fn('Cli.runCatalogAction')(function* (selected: CatalogAction) {
      if (isConnectionAction(selected)) return yield* runConnectionAction(selected)
      switch (selected.type) {
        case 'model-list': {
          const listOptions: PiModelListOptions = {
            availableOnly: selected.available,
          }
          if (selected.provider !== undefined) listOptions.provider = selected.provider
          const models = yield* options.listPiModels(listOptions)
          yield* Console.log(selected.json ? JSON.stringify(models) : renderPiModels(models))
          return
        }
        case 'model-get': {
          const model = yield* options.getPiModel(selected.provider, selected.modelId)
          yield* Console.log(
            model === undefined
              ? selected.json
                ? 'null'
                : `Pi catalog model ${selected.provider}/${selected.modelId} was not found.`
              : selected.json
                ? JSON.stringify(model)
                : renderPiModel(model),
          )
          return
        }
        case 'model-reload': {
          const count = yield* options.reloadPiModels()
          yield* Console.log(
            `Pi model catalog and authentication state reloaded locally (${count} models, no network access).`,
          )
          return
        }
        case 'config-admin-discord-add': {
          const outcome = yield* options.addDiscordAdmin(selected.userId)
          yield* Console.log(formatDiscordAdminAdd(selected.userId, outcome))
          return
        }
        case 'config-admin-discord-remove': {
          const outcome = yield* options.removeDiscordAdmin(selected.userId)
          yield* Console.log(formatDiscordAdminRemove(selected.userId, outcome))
          return
        }
        case 'config-admin-discord-list': {
          const userIds = yield* options.listDiscordAdmins()
          yield* Console.log(
            selected.json ? JSON.stringify(userIds) : renderDiscordAdminList(userIds),
          )
          return
        }
        case 'config-root-user-add': {
          const rootUser: RootUser = {
            platform: selected.platform,
            scopeId: selected.scopeId,
            userId: selected.userId,
          }
          const outcome = yield* options.addRootUser(rootUser)
          yield* Console.log(formatRootUserAdd(rootUser, outcome))
          return
        }
        case 'config-root-user-remove': {
          const rootUser: RootUser = {
            platform: selected.platform,
            scopeId: selected.scopeId,
            userId: selected.userId,
          }
          const outcome = yield* options.removeRootUser(rootUser)
          yield* Console.log(formatRootUserRemove(rootUser, outcome))
          return
        }
        case 'config-root-user-list': {
          const rootUsers = yield* options.listRootUsers()
          yield* Console.log(
            selected.json ? JSON.stringify(rootUsers) : renderRootUserList(rootUsers),
          )
          return
        }
        default: {
          const unhandled: never = selected
          return unhandled
        }
      }
    })
    const runConnectionAction = Effect.fn('Cli.runConnectionAction')(function* (
      selected: ConnectionAction,
    ) {
      switch (selected.type) {
        case 'config-discord-connection-add': {
          const outcome = yield* options.addDiscordConnection(selected)
          yield* Console.log(formatDiscordConnectionAdd(selected.connectionId, outcome))
          return
        }
        case 'config-discord-connection-update': {
          const outcome = yield* options.updateDiscordConnection(selected)
          yield* Console.log(formatDiscordConnectionUpdate(selected.connectionId, outcome))
          return
        }
        case 'config-discord-connection-remove': {
          const outcome = yield* options.removeDiscordConnection(selected.connectionId)
          yield* Console.log(formatDiscordConnectionRemove(selected.connectionId, outcome))
          return
        }
        case 'config-discord-connection-enable': {
          const outcome = yield* options.enableDiscordConnection(selected.connectionId)
          yield* Console.log(formatDiscordConnectionEnable(selected.connectionId, outcome))
          return
        }
        case 'config-discord-connection-disable': {
          const outcome = yield* options.disableDiscordConnection(selected.connectionId)
          yield* Console.log(formatDiscordConnectionDisable(selected.connectionId, outcome))
          return
        }
        case 'config-discord-connection-get': {
          const detail = yield* options.getDiscordConnection(selected.connectionId)
          yield* Console.log(
            Option.match(detail, {
              onNone: () => `Discord connection ${selected.connectionId} is not configured.`,
              onSome: (connection) =>
                selected.json
                  ? JSON.stringify(connection)
                  : renderDiscordConnectionDetail(connection),
            }),
          )
          return
        }
        case 'config-discord-connection-list': {
          const connections = yield* options.listDiscordConnections()
          yield* Console.log(
            selected.json ? JSON.stringify(connections) : renderDiscordConnectionList(connections),
          )
          return
        }
        case 'config-slack-connection-add': {
          const outcome = yield* options.addSlackConnection(selected)
          yield* Console.log(formatSlackConnectionAdd(selected.connectionId, outcome))
          return
        }
        case 'config-slack-connection-update': {
          const outcome = yield* options.updateSlackConnection(selected)
          yield* Console.log(formatSlackConnectionUpdate(selected.connectionId, outcome))
          return
        }
        case 'config-slack-connection-remove': {
          const outcome = yield* options.removeSlackConnection(selected.connectionId)
          yield* Console.log(formatSlackConnectionRemove(selected.connectionId, outcome))
          return
        }
        case 'config-slack-connection-enable': {
          const outcome = yield* options.enableSlackConnection(selected.connectionId)
          yield* Console.log(formatSlackConnectionEnable(selected.connectionId, outcome))
          return
        }
        case 'config-slack-connection-disable': {
          const outcome = yield* options.disableSlackConnection(selected.connectionId)
          yield* Console.log(formatSlackConnectionDisable(selected.connectionId, outcome))
          return
        }
        case 'config-slack-connection-get': {
          const detail = yield* options.getSlackConnection(selected.connectionId)
          yield* Console.log(
            Option.match(detail, {
              onNone: () => `Slack connection ${selected.connectionId} is not configured.`,
              onSome: (connection) =>
                selected.json
                  ? JSON.stringify(connection)
                  : renderSlackConnectionDetail(connection),
            }),
          )
          return
        }
        case 'config-slack-connection-list': {
          const connections = yield* options.listSlackConnections()
          yield* Console.log(
            selected.json ? JSON.stringify(connections) : renderSlackConnectionList(connections),
          )
          return
        }
        default: {
          const unhandled: never = selected
          return unhandled
        }
      }
    })
    const runGuildAction = Effect.fn('Cli.runGuildAction')(function* (selected: GuildAction) {
      switch (selected.type) {
        case 'config-discord-guild-enable': {
          const result = yield* applyDiscordConfigMutation(
            options.enableDiscordGuild(selected.connectionId, selected.guildId),
            (outcome) => outcome === 'enabled',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatDiscordGuildEnable(selected.guildId, outcome),
            ),
          )
          return
        }
        case 'config-discord-guild-disable': {
          const result = yield* applyDiscordConfigMutation(
            options.disableDiscordGuild(selected.connectionId, selected.guildId),
            (outcome) => outcome === 'disabled',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatDiscordGuildDisable(selected.guildId, outcome),
            ),
          )
          return
        }
        case 'config-discord-guild-remove': {
          const result = yield* applyDiscordConfigMutation(
            options.removeDiscordGuild(selected.connectionId, selected.guildId),
            (outcome) => outcome === 'removed',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatDiscordGuildRemove(selected.guildId, outcome),
            ),
          )
          return
        }
        case 'config-discord-guild-list': {
          const guilds = yield* options.listDiscordGuilds(selected.connectionId)
          yield* Console.log(
            selected.json ? JSON.stringify(guilds) : renderDiscordGuildList(guilds),
          )
          return
        }
        case 'config-discord-guild-set-invocation': {
          const result = yield* applyDiscordConfigMutation(
            options.setDiscordGuildInvocation(
              selected.connectionId,
              selected.guildId,
              selected.mode,
            ),
            (outcome) => outcome === 'updated',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatDiscordGuildInvocation(selected.guildId, selected.mode, outcome),
            ),
          )
          return
        }
        case 'config-discord-guild-set-users': {
          const result = yield* applyDiscordConfigMutation(
            options.setDiscordGuildUsers(selected.connectionId, selected.guildId, selected.policy),
            (outcome) => outcome === 'updated',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatDiscordGuildUsers(selected.guildId, selected.policy, outcome),
            ),
          )
          return
        }
        case 'config-discord-guild-set-channels': {
          const result = yield* applyDiscordConfigMutation(
            options.setDiscordGuildChannels(
              selected.connectionId,
              selected.guildId,
              selected.policy,
            ),
            (outcome) => outcome === 'updated',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatDiscordGuildChannels(selected.guildId, selected.policy, outcome),
            ),
          )
          return
        }
        case 'config-discord-guild-channel-set': {
          const result = yield* applyDiscordConfigMutation(
            options.setDiscordGuildChannel(
              selected.connectionId,
              selected.guildId,
              selected.channelId,
              selected.patch,
            ),
            (outcome) => outcome === 'updated',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatDiscordGuildChannelSet(selected.channelId, outcome),
            ),
          )
          return
        }
        case 'config-discord-guild-channel-reset': {
          const result = yield* applyDiscordConfigMutation(
            options.resetDiscordGuildChannel(
              selected.connectionId,
              selected.guildId,
              selected.channelId,
            ),
            (outcome) => outcome === 'removed',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatDiscordGuildChannelReset(selected.channelId, outcome),
            ),
          )
          return
        }
        case 'config-slack-access-set': {
          const result = yield* applyDiscordConfigMutation(
            options.setSlackAccess(selected.connectionId, selected.subject, selected.policy),
            (outcome) => outcome === 'updated',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatSlackAccessSet(selected.subject, selected.policy, outcome),
            ),
          )
          return
        }
        case 'config-slack-channel-set': {
          const result = yield* applyDiscordConfigMutation(
            options.setSlackChannel(selected.connectionId, selected.channelId, selected.patch),
            (outcome) => outcome === 'updated',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatSlackChannelSet(selected.channelId, selected.patch, outcome),
            ),
          )
          return
        }
        case 'config-slack-channel-reset': {
          const result = yield* applyDiscordConfigMutation(
            options.resetSlackChannel(selected.connectionId, selected.channelId),
            (outcome) => outcome === 'removed',
            options.reloadConfig,
          )
          yield* Console.log(
            formatDiscordConfigMutation(result, (outcome) =>
              formatSlackChannelReset(selected.channelId, outcome),
            ),
          )
          return
        }
        default: {
          const unhandled: never = selected
          return unhandled
        }
      }
    })
    const runRuntimeAction = Effect.fn('Cli.runRuntimeAction')(function* (selected: RuntimeAction) {
      if (isDocumentAction(selected)) return yield* runDocumentAction(selected)
      switch (selected.type) {
        case 'workspace-cleanup-apply': {
          const result = yield* options.applyWorkspaceCleanup(selected, process.cwd())
          yield* Console.log(selected.json ? JSON.stringify(result) : renderCleanup(result))
          return
        }
        case 'workspace-cleanup-list': {
          const proposals = yield* options.listWorkspaceCleanupProposals()
          yield* Console.log(
            selected.json ? JSON.stringify(proposals) : renderWorkspaceCleanupList(proposals),
          )
          return
        }
        case 'worktree-ensure': {
          const result = yield* options.ensureWorktree(selected)
          yield* Console.log(selected.json ? JSON.stringify(result) : renderWorktree(result))
          return
        }
        case 'worktree-list': {
          const worktrees = yield* options.listWorktrees()
          yield* Console.log(
            selected.json ? JSON.stringify(worktrees) : renderWorktreeList(worktrees),
          )
          return
        }
        case 'start':
          return yield* options.start
        default: {
          const unhandled: never = selected
          return unhandled
        }
      }
    })
    const runDocumentAction = Effect.fn('Cli.runDocumentAction')(function* (
      selected: DocumentAction,
    ) {
      switch (selected.type) {
        case 'document-save': {
          const content = yield* options.readDocumentContent(selected.file)
          const saved = yield* options.saveDocument(selected.key, selected.format, content)
          yield* Console.log(
            selected.json
              ? JSON.stringify({ ...saved.metadata, url: saved.url })
              : `Document '${selected.key}' saved.\nURL: ${saved.url}`,
          )
          return
        }
        case 'document-get': {
          const found = yield* options.getDocument(selected.key)
          yield* Console.log(
            Option.match(found, {
              onNone: () => (selected.json ? 'null' : `Document '${selected.key}' was not found.`),
              onSome: (document) =>
                selected.json
                  ? JSON.stringify({ ...document.metadata, content: document.content })
                  : document.content,
            }),
          )
          return
        }
        case 'document-list': {
          const documents = yield* options.listDocuments()
          yield* Console.log(
            selected.json ? JSON.stringify(documents) : renderDocumentList(documents),
          )
          return
        }
        case 'document-url': {
          const found = yield* options.getDocumentUrl(selected.key)
          yield* Console.log(
            Option.match(found, {
              onNone: () => (selected.json ? 'null' : `Document '${selected.key}' was not found.`),
              onSome: (url) => (selected.json ? JSON.stringify({ key: selected.key, url }) : url),
            }),
          )
          return
        }
        case 'document-revoke': {
          const found = yield* options.revokeDocument(selected.key)
          yield* Console.log(
            Option.match(found, {
              onNone: () => (selected.json ? 'null' : `Document '${selected.key}' was not found.`),
              onSome: (revoked) =>
                selected.json
                  ? JSON.stringify({ ...revoked.metadata, url: revoked.url })
                  : `Document '${selected.key}' access revoked.\nNew URL: ${revoked.url}`,
            }),
          )
          return
        }
        case 'config-document-get': {
          const config = yield* options.getDocumentConfig()
          yield* Console.log(selected.json ? JSON.stringify(config) : renderDocumentConfig(config))
          return
        }
        case 'config-document-set': {
          const config = yield* options.updateDocumentConfig(selected.patch)
          yield* Console.log(selected.json ? JSON.stringify(config) : renderDocumentConfig(config))
          return
        }
        case 'document-remove': {
          const outcome = yield* options.removeDocument(selected.key)
          yield* Console.log(
            outcome === 'removed'
              ? `Document '${selected.key}' removed.`
              : `Document '${selected.key}' was not found.`,
          )
          return
        }
        default: {
          const unhandled: never = selected
          return unhandled
        }
      }
    })
    if (isConfigurationAction(action)) return yield* runConfigurationAction(action)
    if (isCatalogAction(action)) return yield* runCatalogAction(action)
    if (isGuildAction(action)) return yield* runGuildAction(action)
    return yield* runRuntimeAction(action)
  })
