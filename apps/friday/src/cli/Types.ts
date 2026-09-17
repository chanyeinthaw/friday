import * as Schema from 'effect/Schema'
import {
  ModelId,
  PlatformConnectionId,
  ProviderId,
  SubagentProfileName,
  ThinkingLevel,
} from '@friday/contracts/conversation'

import type {
  AccessPolicy,
  InvocationMode as InvocationModeType,
  ReplyMode as ReplyModeType,
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
import {
  ConfiguredModelSelection,
  FixedModelName,
  StoredSubagentProfile,
} from '../config/ModelConfiguration.ts'
import { RepositoryUrl } from '../repositories/RepositoryWorktrees.ts'
import { WorkspaceCleanupProposalId } from '../workspaces/WorkspaceCleanup.ts'
import {
  DocumentKey,
  type DocumentConfigPatch,
  type DocumentFormat,
} from '../documents/Documents.ts'

export type FridayCliAction =
  | { readonly type: 'help'; readonly topic: ReadonlyArray<string> }
  | { readonly type: 'start' }
  | { readonly type: 'version' }
  | { readonly type: 'config-reload' }
  | { readonly type: 'config-model-list'; readonly json: boolean }
  | { readonly type: 'config-model-get'; readonly name: FixedModelName; readonly json: boolean }
  | { readonly type: 'config-model-set'; readonly selection: ConfiguredModelSelection }
  | { readonly type: 'config-profile-list'; readonly json: boolean }
  | {
      readonly type: 'config-profile-get'
      readonly name: SubagentProfileName
      readonly json: boolean
    }
  | { readonly type: 'config-profile-add'; readonly profile: StoredSubagentProfile }
  | {
      readonly type: 'config-profile-update'
      readonly patch: {
        readonly name: SubagentProfileName
        readonly description?: string
        readonly provider?: ProviderId
        readonly modelId?: ModelId
        readonly thinkingLevel?: ThinkingLevel
      }
    }
  | {
      readonly type: 'config-profile-remove'
      readonly name: SubagentProfileName
      readonly yes: boolean
    }
  | {
      readonly type: 'model-list'
      readonly provider?: string
      readonly available: boolean
      readonly json: boolean
    }
  | {
      readonly type: 'model-get'
      readonly provider: string
      readonly modelId: string
      readonly json: boolean
    }
  | { readonly type: 'model-reload' }
  | {
      readonly type: 'config-admin-discord-add' | 'config-admin-discord-remove'
      readonly userId: DiscordUserId
    }
  | { readonly type: 'config-admin-discord-list'; readonly json: boolean }
  | {
      readonly type: 'config-root-user-add' | 'config-root-user-remove'
      readonly platform: RootUserPlatform
      readonly scopeId: RootUserScopeId
      readonly userId: RootUserId
    }
  | { readonly type: 'config-root-user-list'; readonly json: boolean }
  | { readonly type: 'config-identity-get'; readonly json: boolean }
  | { readonly type: 'config-identity-set'; readonly text: IdentityText }
  | { readonly type: 'config-discord-connection-list'; readonly json: boolean }
  | {
      readonly type: 'config-discord-connection-add'
      readonly connectionId: PlatformConnectionId
      readonly name: string
      readonly applicationId: DiscordSnowflake
      readonly publicKey: DiscordPublicKey
      readonly botTokenEnv: BotTokenEnvName
      readonly respondToGlobalMentions: boolean
    }
  | {
      readonly type: 'config-discord-connection-update'
      readonly connectionId: PlatformConnectionId
      readonly name?: string
      readonly applicationId?: DiscordSnowflake
      readonly publicKey?: DiscordPublicKey
      readonly botTokenEnv?: BotTokenEnvName
      readonly respondToGlobalMentions?: boolean
    }
  | {
      readonly type: 'config-discord-connection-remove'
      readonly connectionId: PlatformConnectionId
      readonly yes: boolean
    }
  | {
      readonly type: 'config-discord-connection-enable' | 'config-discord-connection-disable'
      readonly connectionId: PlatformConnectionId
    }
  | {
      readonly type: 'config-discord-connection-get'
      readonly connectionId: PlatformConnectionId
      readonly json: boolean
    }
  | { readonly type: 'config-slack-connection-list'; readonly json: boolean }
  | {
      readonly type: 'config-slack-connection-add'
      readonly connectionId: PlatformConnectionId
      readonly name: string
      readonly botTokenEnv: SlackTokenEnvName
      readonly appTokenEnv: SlackTokenEnvName
      readonly defaultReplyMode: ReplyModeType
    }
  | {
      readonly type: 'config-slack-connection-update'
      readonly connectionId: PlatformConnectionId
      readonly name?: string
      readonly botTokenEnv?: SlackTokenEnvName
      readonly appTokenEnv?: SlackTokenEnvName
      readonly defaultReplyMode?: ReplyModeType
    }
  | {
      readonly type: 'config-slack-connection-remove'
      readonly connectionId: PlatformConnectionId
      readonly yes: boolean
    }
  | {
      readonly type: 'config-slack-connection-enable' | 'config-slack-connection-disable'
      readonly connectionId: PlatformConnectionId
    }
  | {
      readonly type: 'config-slack-connection-get'
      readonly connectionId: PlatformConnectionId
      readonly json: boolean
    }
  | {
      readonly type: 'config-slack-access-set'
      readonly connectionId: PlatformConnectionId
      readonly subject: SlackAccessSubject
      readonly policy: AccessPolicy
    }
  | {
      readonly type: 'config-slack-channel-set'
      readonly connectionId: PlatformConnectionId
      readonly channelId: SlackChannelId
      readonly patch: SlackChannelPatch
    }
  | {
      readonly type: 'config-slack-channel-reset'
      readonly connectionId: PlatformConnectionId
      readonly channelId: SlackChannelId
    }
  | {
      readonly type: 'config-discord-guild-enable' | 'config-discord-guild-disable'
      readonly connectionId: PlatformConnectionId
      readonly guildId: DiscordGuildId
    }
  | {
      readonly type: 'config-discord-guild-remove'
      readonly connectionId: PlatformConnectionId
      readonly guildId: DiscordGuildId
      readonly yes: boolean
    }
  | {
      readonly type: 'config-discord-guild-list'
      readonly connectionId: PlatformConnectionId
      readonly json: boolean
    }
  | {
      readonly type: 'config-discord-guild-set-invocation'
      readonly connectionId: PlatformConnectionId
      readonly guildId: DiscordGuildId
      readonly mode: InvocationModeType
    }
  | {
      readonly type: 'config-discord-guild-set-users'
      readonly connectionId: PlatformConnectionId
      readonly guildId: DiscordGuildId
      readonly policy: AccessPolicy
    }
  | {
      readonly type: 'config-discord-guild-set-channels'
      readonly connectionId: PlatformConnectionId
      readonly guildId: DiscordGuildId
      readonly policy: AccessPolicy
    }
  | {
      readonly type: 'config-discord-guild-channel-set'
      readonly connectionId: PlatformConnectionId
      readonly guildId: DiscordGuildId
      readonly channelId: DiscordGuildChannelId
      readonly patch: DiscordGuildChannelPatch
    }
  | {
      readonly type: 'config-discord-guild-channel-reset'
      readonly connectionId: PlatformConnectionId
      readonly guildId: DiscordGuildId
      readonly channelId: DiscordGuildChannelId
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
      readonly branch?: string
      readonly json: boolean
    }
  | { readonly type: 'worktree-list'; readonly json: boolean }
  | {
      readonly type: 'document-save'
      readonly key: DocumentKey
      readonly format: DocumentFormat
      readonly file?: string
      readonly json: boolean
    }
  | { readonly type: 'document-get'; readonly key: DocumentKey; readonly json: boolean }
  | { readonly type: 'document-list'; readonly json: boolean }
  | { readonly type: 'document-url'; readonly key: DocumentKey; readonly json: boolean }
  | { readonly type: 'document-revoke'; readonly key: DocumentKey; readonly json: boolean }
  | { readonly type: 'document-remove'; readonly key: DocumentKey; readonly yes: boolean }
  | { readonly type: 'config-document-get'; readonly json: boolean }
  | {
      readonly type: 'config-document-set'
      readonly patch: DocumentConfigPatch
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
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.detail ?? `Unknown or invalid Friday command: ${this.argument}`
  }
}
