import * as Effect from 'effect/Effect'

import type { PlatformConnectionId } from '@friday/contracts/conversation'
import type {
  AccessPolicy,
  DiscordGuildChannelConfig,
  DiscordGuildConfig,
  InvocationMode as InvocationModeType,
} from '../config/AppConfig.ts'
import type {
  DiscordGuildChannelId,
  DiscordGuildChannelResetOutcome,
  DiscordGuildId,
  DiscordGuildChannelUpdateOutcome,
  DiscordGuildDisableOutcome,
  DiscordGuildEnableOutcome,
  DiscordGuildRemoveOutcome,
  DiscordGuildUpdateOutcome,
} from '../config/DiscordGuilds.ts'
import type {
  DiscordConnectionAddOutcome,
  DiscordConnectionDetail,
  DiscordConnectionDisableOutcome,
  DiscordConnectionEnableOutcome,
  DiscordConnectionRecord,
  DiscordConnectionRemoveOutcome,
  DiscordConnectionUpdateOutcome,
} from '../config/DiscordConnections.ts'
import type {
  SlackAccessSubject,
  SlackAccessUpdateOutcome,
  SlackChannelId,
  SlackChannelPatch,
  SlackChannelResetOutcome,
  SlackChannelUpdateOutcome,
  SlackConnectionAddOutcome,
  SlackConnectionDetail,
  SlackConnectionDisableOutcome,
  SlackConnectionEnableOutcome,
  SlackConnectionRecord,
  SlackConnectionRemoveOutcome,
  SlackConnectionUpdateOutcome,
} from '../config/SlackConnections.ts'
import { isControlSocketUnavailable, type ControlSocketError } from '../control/ControlSocket.ts'
import { type ConfigReloadOutcome as ConfigReloadOutcomeType } from '../config/ConfigReload.ts'
import type {
  DiscordAdminAddOutcome,
  DiscordAdminRemoveOutcome,
  DiscordUserId,
} from '../config/DiscordAdmins.ts'
import type { RootUser, RootUserAddOutcome, RootUserRemoveOutcome } from '../config/RootUsers.ts'
import type {
  ConfiguredModelSelection,
  StoredSubagentProfile,
} from '../config/ModelConfiguration.ts'
import type { PiCatalogModel } from '../harness/pi/PiModelCatalog.ts'
import type {
  ManagedWorktree,
  ManagedWorktreeListEntry,
} from '../repositories/RepositoryWorktrees.ts'
import type { WorkspaceCleanupProposal } from '../workspaces/WorkspaceCleanup.ts'
import type { DocumentConfig, DocumentMetadata } from '../documents/Documents.ts'

export const renderConfiguredModels = (models: ReadonlyArray<ConfiguredModelSelection>): string =>
  [
    'Friday model selections:',
    ...models.map(
      (model) => `  ${model.name}: ${model.provider}/${model.modelId} (${model.thinkingLevel})`,
    ),
  ].join('\n')

export const renderSubagentProfiles = (profiles: ReadonlyArray<StoredSubagentProfile>): string =>
  profiles.length === 0
    ? 'No subagent profiles are configured.'
    : [
        'Subagent profiles:',
        ...profiles.map(
          (profile) =>
            `  ${profile.name}: ${profile.provider}/${profile.modelId} (${profile.thinkingLevel})\n    ${profile.description}`,
        ),
      ].join('\n')

export const renderPiModels = (models: ReadonlyArray<PiCatalogModel>): string =>
  models.length === 0
    ? 'No matching Pi catalog models.'
    : [
        'Pi model catalog:',
        ...models.map(
          (model) =>
            `  ${model.provider}/${model.modelId}  ${model.available ? 'available' : 'unavailable'}  ${model.name}`,
        ),
      ].join('\n')

export const renderPiModel = (model: PiCatalogModel): string =>
  [
    `${model.provider}/${model.modelId}`,
    `  Name: ${model.name}`,
    `  API: ${model.api}`,
    `  Available: ${model.available ? 'yes' : 'no'}`,
    `  Reasoning: ${model.reasoning ? 'yes' : 'no'}`,
    `  Input: ${model.input.join(', ')}`,
    `  Context window: ${model.contextWindow}`,
    `  Max tokens: ${model.maxTokens}`,
  ].join('\n')

export const renderCleanup = (
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

export const renderWorktreeLine = (worktree: ManagedWorktreeListEntry): string =>
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

/** Human-readable document list without URLs; URLs come only from save, url, and revoke. */
export const renderDocumentList = (documents: ReadonlyArray<DocumentMetadata>): string =>
  documents.length === 0
    ? 'No documents are published.'
    : [
        'Published documents:',
        ...documents.map(
          (document) => `  ${document.key}  ${document.format}  ${document.sizeBytes} bytes`,
        ),
      ].join('\n')

export const renderDocumentConfig = (config: DocumentConfig): string =>
  [
    `Public base URL: ${config.publicBaseUrl}`,
    `Listen host: ${config.listenHost}`,
    `Listen port: ${config.listenPort}`,
    `Maximum bytes: ${config.maxBytes}`,
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
  userId: DiscordUserId,
  outcome: DiscordAdminAddOutcome,
): string =>
  outcome === 'added'
    ? `Discord admin ${userId} added. Restart Friday to apply it: the admin allow-list is pinned at startup.`
    : `Discord admin ${userId} is already configured.`

/** Human-readable remove outcome; the restart note reflects startup-pinned admins. */
export const formatDiscordAdminRemove = (
  userId: DiscordUserId,
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

const formatRootUserIdentity = (rootUser: RootUser): string =>
  `${rootUser.platform} ${rootUser.scopeId} ${rootUser.userId}`

/** Human-readable add outcome; root-user changes apply live on next prompt render. */
export const formatRootUserAdd = (rootUser: RootUser, outcome: RootUserAddOutcome): string =>
  outcome === 'added'
    ? `Root user ${formatRootUserIdentity(rootUser)} added.`
    : `Root user ${formatRootUserIdentity(rootUser)} is already configured.`

/** Human-readable remove outcome; root-user changes apply live on next prompt render. */
export const formatRootUserRemove = (rootUser: RootUser, outcome: RootUserRemoveOutcome): string =>
  outcome === 'removed'
    ? `Root user ${formatRootUserIdentity(rootUser)} removed.`
    : `Root user ${formatRootUserIdentity(rootUser)} is not configured.`

/** Human-readable root-user list in stable sorted order. */
export const renderRootUserList = (rootUsers: ReadonlyArray<RootUser>): string =>
  rootUsers.length === 0
    ? 'No root users are configured.'
    : ['Root users:', ...rootUsers.map((rootUser) => `  ${formatRootUserIdentity(rootUser)}`)].join(
        '\n',
      )

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
  ].join('\n')

const restartNote = 'Restart Friday to apply it: connection topology is pinned at startup.'

export const formatDiscordConnectionAdd = (
  connectionId: PlatformConnectionId,
  outcome: DiscordConnectionAddOutcome,
): string =>
  outcome === 'added'
    ? `Discord connection ${connectionId} added. ${restartNote}`
    : outcome === 'connection-exists'
      ? `A connection named ${connectionId} already exists.`
      : 'The application ID is already used by another Discord connection.'

export const formatDiscordConnectionUpdate = (
  connectionId: PlatformConnectionId,
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
  connectionId: PlatformConnectionId,
  outcome: DiscordConnectionRemoveOutcome,
): string =>
  outcome === 'removed'
    ? `Discord connection ${connectionId} removed together with its Discord configuration. ${restartNote}`
    : `Discord connection ${connectionId} is not configured.`

export const formatDiscordConnectionEnable = (
  connectionId: PlatformConnectionId,
  outcome: DiscordConnectionEnableOutcome,
): string =>
  outcome === 'enabled'
    ? `Discord connection ${connectionId} enabled. ${restartNote}`
    : outcome === 'already-enabled'
      ? `Discord connection ${connectionId} is already enabled.`
      : `Discord connection ${connectionId} is not configured.`

export const formatDiscordConnectionDisable = (
  connectionId: PlatformConnectionId,
  outcome: DiscordConnectionDisableOutcome,
): string =>
  outcome === 'disabled'
    ? `Discord connection ${connectionId} disabled. ${restartNote}`
    : outcome === 'already-disabled'
      ? `Discord connection ${connectionId} is already disabled.`
      : `Discord connection ${connectionId} is not configured.`

export const renderSlackConnectionList = (
  connections: ReadonlyArray<SlackConnectionRecord>,
): string =>
  connections.length === 0
    ? 'No Slack connections are configured.'
    : [
        'Slack connections:',
        ...connections.map(
          ({ connectionId, name, enabled }) =>
            `  ${connectionId}  ${enabled ? 'enabled' : 'disabled'}  ${name}`,
        ),
      ].join('\n')

export const renderSlackConnectionDetail = (detail: SlackConnectionDetail): string =>
  [
    `Slack connection ${detail.connectionId}:`,
    `  Name: ${detail.name}`,
    `  Enabled: ${detail.enabled ? 'yes' : 'no'}`,
    `  Bot token env: ${detail.botTokenEnv}`,
    `  App token env: ${detail.appTokenEnv}`,
    `  Default reply mode: ${detail.defaultReplyMode}`,
    `  Users: ${renderGuildPolicy(detail.users)}`,
    `  Channels: ${renderGuildPolicy(detail.channels)}`,
    `  Workspaces: ${renderGuildPolicy(detail.workspaces)}`,
    ...(detail.channelOverrides.length === 0
      ? []
      : [
          '  Channel overrides:',
          ...detail.channelOverrides.map((override) => {
            const overrides = [
              override.invocationMode === undefined
                ? undefined
                : `invocation: ${override.invocationMode}`,
              override.replyMode === undefined ? undefined : `reply: ${override.replyMode}`,
            ].filter((entry) => entry !== undefined)
            return `    ${override.channelId}: ${overrides.length === 0 ? '(no overrides)' : overrides.join(', ')}`
          }),
        ]),
  ].join('\n')

export const formatSlackConnectionAdd = (
  connectionId: PlatformConnectionId,
  outcome: SlackConnectionAddOutcome,
): string =>
  outcome === 'added'
    ? `Slack connection ${connectionId} added. ${restartNote}`
    : `A connection named ${connectionId} already exists.`

export const formatSlackConnectionUpdate = (
  connectionId: PlatformConnectionId,
  outcome: SlackConnectionUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Slack connection ${connectionId} updated. ${restartNote}`
    : outcome === 'unchanged'
      ? `Slack connection ${connectionId} already has the requested configuration; nothing changed.`
      : `Slack connection ${connectionId} is not configured.`

export const formatSlackConnectionRemove = (
  connectionId: PlatformConnectionId,
  outcome: SlackConnectionRemoveOutcome,
): string =>
  outcome === 'removed'
    ? `Slack connection ${connectionId} removed together with its Slack configuration. ${restartNote}`
    : `Slack connection ${connectionId} is not configured.`

export const formatSlackConnectionEnable = (
  connectionId: PlatformConnectionId,
  outcome: SlackConnectionEnableOutcome,
): string =>
  outcome === 'enabled'
    ? `Slack connection ${connectionId} enabled. ${restartNote}`
    : outcome === 'already-enabled'
      ? `Slack connection ${connectionId} is already enabled.`
      : `Slack connection ${connectionId} is not configured.`

export const formatSlackConnectionDisable = (
  connectionId: PlatformConnectionId,
  outcome: SlackConnectionDisableOutcome,
): string =>
  outcome === 'disabled'
    ? `Slack connection ${connectionId} disabled. ${restartNote}`
    : outcome === 'already-disabled'
      ? `Slack connection ${connectionId} is already disabled.`
      : `Slack connection ${connectionId} is not configured.`

export const formatSlackAccessSet = (
  subject: SlackAccessSubject,
  policy: AccessPolicy,
  outcome: SlackAccessUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Slack ${subject} policy set to ${renderGuildPolicy(policy)}.`
    : outcome === 'unchanged'
      ? `Slack ${subject} policy is already ${renderGuildPolicy(policy)}.`
      : 'Slack connection is not configured.'

export const formatSlackChannelSet = (
  channelId: SlackChannelId,
  patch: SlackChannelPatch,
  outcome: SlackChannelUpdateOutcome,
): string => {
  const overrides = [
    patch.invocationMode === undefined ? undefined : `invocation ${patch.invocationMode}`,
    patch.replyMode === undefined ? undefined : `reply ${patch.replyMode}`,
  ].filter((entry) => entry !== undefined)
  const scope = overrides.length === 0 ? 'override' : overrides.join(', ')
  return outcome === 'updated'
    ? `Slack channel ${channelId} ${scope} updated.`
    : outcome === 'unchanged'
      ? `Slack channel ${channelId} ${scope} is unchanged.`
      : 'Slack connection is not configured.'
}

export const formatSlackChannelReset = (
  channelId: SlackChannelId,
  outcome: SlackChannelResetOutcome,
): string =>
  outcome === 'removed'
    ? `Slack channel ${channelId} override removed; the connection default applies.`
    : `No override is configured for Slack channel ${channelId}.`

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
            `guild ${guild.guildId}: ${guild.enabled ? 'enabled' : 'disabled'}, invocation: ${guild.invocation.defaultMode}${guild.users === undefined ? '' : `, users: ${renderGuildPolicy(guild.users)}`}${guild.channelScope === undefined ? '' : `, channels: ${renderGuildPolicy(guild.channelScope)}`}`,
            ...guild.channels.map(renderGuildChannel),
          ].join('\n'),
        )
        .join('\n')

export type DiscordConfigApplicationOutcome =
  | { readonly _tag: 'reloaded'; readonly version: number }
  | { readonly _tag: 'next-startup' }
  | { readonly _tag: 'rejected'; readonly detail: string }
  | { readonly _tag: 'unconfirmed'; readonly detail: string }

export interface DiscordConfigMutationResult<A> {
  readonly outcome: A
  readonly application?: DiscordConfigApplicationOutcome
}

/**
 * Runs a durable guild/channel write before requesting a live snapshot reload.
 * Unchanged outcomes skip reload, while reload failures remain separate from
 * the already-committed write.
 */
export const applyDiscordConfigMutation = <A, E>(
  write: Effect.Effect<A, E>,
  changed: (outcome: A) => boolean,
  reload: Effect.Effect<ConfigReloadOutcomeType, ControlSocketError>,
): Effect.Effect<DiscordConfigMutationResult<A>, E> =>
  Effect.gen(function* () {
    const outcome = yield* write
    if (!changed(outcome)) return { outcome }
    const reloadAttempt = yield* reload.pipe(
      Effect.map((response) => ({ _tag: 'response' as const, response })),
      Effect.catch((error) => Effect.succeed({ _tag: 'transport-error' as const, error })),
    )
    if (reloadAttempt._tag === 'transport-error') {
      return {
        outcome,
        application: isControlSocketUnavailable(reloadAttempt.error)
          ? { _tag: 'next-startup' }
          : { _tag: 'unconfirmed', detail: reloadAttempt.error.message },
      }
    }
    return {
      outcome,
      application: reloadAttempt.response.ok
        ? { _tag: 'reloaded', version: reloadAttempt.response.version }
        : { _tag: 'rejected', detail: reloadAttempt.response.detail },
    }
  })

const formatDiscordConfigApplication = (
  application: DiscordConfigApplicationOutcome | undefined,
): string => {
  if (application === undefined) return ''
  if (application._tag === 'reloaded') {
    return ` Saved; Friday reloaded configuration version ${application.version}.`
  }
  if (application._tag === 'next-startup') {
    return ' Saved. Friday is not running; the change will apply on next startup.'
  }
  if (application._tag === 'rejected') {
    return ` Saved, but the running Friday rejected the reload: ${application.detail}`
  }
  return ` Saved, but live application could not be confirmed: ${application.detail}`
}

export const formatDiscordConfigMutation = <A>(
  result: DiscordConfigMutationResult<A>,
  format: (outcome: A) => string,
): string => `${format(result.outcome)}${formatDiscordConfigApplication(result.application)}`

export const formatDiscordGuildEnable = (
  guildId: DiscordGuildId,
  outcome: DiscordGuildEnableOutcome,
): string =>
  outcome === 'enabled' ? `Guild ${guildId} enabled.` : `Guild ${guildId} is already enabled.`

export const formatDiscordGuildDisable = (
  guildId: DiscordGuildId,
  outcome: DiscordGuildDisableOutcome,
): string =>
  outcome === 'disabled'
    ? `Guild ${guildId} disabled.`
    : outcome === 'already-disabled'
      ? `Guild ${guildId} is already disabled.`
      : `Guild ${guildId} is not configured.`

export const formatDiscordGuildRemove = (
  guildId: DiscordGuildId,
  outcome: DiscordGuildRemoveOutcome,
): string =>
  outcome === 'removed'
    ? `Guild ${guildId} removed together with its channel overrides.`
    : `Guild ${guildId} is not configured.`

export const formatDiscordGuildInvocation = (
  guildId: DiscordGuildId,
  mode: InvocationModeType,
  outcome: DiscordGuildUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Guild-wide invocation default for ${guildId} set to ${mode}.`
    : outcome === 'unchanged'
      ? `Guild-wide invocation default for ${guildId} is already ${mode}.`
      : `Guild ${guildId} is not configured. Enable it first.`

export const formatDiscordGuildUsers = (
  guildId: DiscordGuildId,
  policy: AccessPolicy,
  outcome: DiscordGuildUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Guild-wide user permission default for ${guildId} set to ${renderGuildPolicy(policy)}.`
    : outcome === 'unchanged'
      ? `Guild-wide user permission default for ${guildId} is already ${renderGuildPolicy(policy)}.`
      : `Guild ${guildId} is not configured. Enable it first.`

export const formatDiscordGuildChannels = (
  guildId: DiscordGuildId,
  policy: AccessPolicy,
  outcome: DiscordGuildUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Guild channel scope for ${guildId} set to ${renderGuildPolicy(policy)}.`
    : outcome === 'unchanged'
      ? `Guild channel scope for ${guildId} is already ${renderGuildPolicy(policy)}.`
      : `Guild ${guildId} is not configured. Enable it first.`

export const formatDiscordGuildChannelSet = (
  channelId: DiscordGuildChannelId,
  outcome: DiscordGuildChannelUpdateOutcome,
): string =>
  outcome === 'updated'
    ? `Channel ${channelId} overrides updated.`
    : outcome === 'unchanged'
      ? `Channel ${channelId} overrides are unchanged.`
      : `The guild owning channel ${channelId} is not configured. Enable it first.`

export const formatDiscordGuildChannelReset = (
  channelId: DiscordGuildChannelId,
  outcome: DiscordGuildChannelResetOutcome,
): string =>
  outcome === 'removed'
    ? `Channel ${channelId} overrides removed; guild defaults apply.`
    : `No overrides are configured for channel ${channelId}.`

export const renderWorktree = (worktree: ManagedWorktree): string => `Repository worktree ready
  URL: ${worktree.url}
  Path: ${worktree.path}
  Branch: ${worktree.branch}
  Base: ${worktree.baseRef}
  Reused: ${worktree.reused ? 'yes' : 'no'}`
