/* oxlint-disable anti-slop/no-unsafe-dictionary-type, eslint/no-underscore-dangle -- SQL row payloads are decoded immediately through Effect Schema; Effect schema errors use the canonical _tag discriminator. */

import {
  ModelSelection,
  PlatformConnectionId,
  SubagentProfileName,
  ThinkingLevel,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { DiscordLink } from './DiscordLinks.ts'

const Identifier = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))
const IdentifierArray = Schema.Array(Identifier)

export const AccessPolicy = Schema.Struct({
  mode: Schema.Literals(['all', 'allow', 'deny']),
  ids: IdentifierArray,
})
export type AccessPolicy = typeof AccessPolicy.Type

export const SecretValue = Identifier.pipe(Schema.brand('SecretValue'))
export type SecretValue = typeof SecretValue.Type

export const SubagentProfile = Schema.Struct({
  name: SubagentProfileName,
  description: Identifier,
  model: ModelSelection,
  thinkingLevel: ThinkingLevel,
})
export type SubagentProfile = typeof SubagentProfile.Type

const ConfiguredModel = Schema.Struct({
  ...ModelSelection.fields,
  thinkingLevel: ThinkingLevel,
})

export const InvocationMode = Schema.Literals(['mention-only', 'all-messages'])
export type InvocationMode = typeof InvocationMode.Type

/**
 * How Friday answers in a Discord channel: in a thread rooted at the invoking
 * message (the default), or directly in the channel itself.
 */
export const ReplyMode = Schema.Literals(['reply-in-thread', 'reply-in-channel'])
export type ReplyMode = typeof ReplyMode.Type

/** The default reply behavior for every channel without an explicit override. */
export const DefaultReplyMode: ReplyMode = 'reply-in-thread'

/**
 * One guild-scoped channel override. Every field is optional: a channel row
 * exists because at least one override is configured, and absent fields inherit
 * the guild-wide defaults.
 */
export const DiscordGuildChannelConfig = Schema.Struct({
  channelId: Identifier,
  invocationMode: Schema.optionalKey(InvocationMode),
  users: Schema.optionalKey(AccessPolicy),
  replyMode: Schema.optionalKey(ReplyMode),
})
export type DiscordGuildChannelConfig = typeof DiscordGuildChannelConfig.Type

/**
 * A first-class enabled operational boundary. A guild that is absent from this
 * list, or present with `enabled: false`, never receives any Friday activity.
 * Guild-wide defaults apply to all of the guild's channels; per-channel entries
 * override them.
 */
export const DiscordGuildConfig = Schema.Struct({
  guildId: Identifier,
  enabled: Schema.Boolean,
  invocation: Schema.Struct({ defaultMode: InvocationMode }),
  /** Guild-wide user permission default; absent means inherit the connection policy. */
  users: Schema.optionalKey(AccessPolicy),
  /**
   * Guild-wide channel scope: which channels admit Friday at all. Absent means
   * `all` (every channel of the guild). This is the scope control and stays
   * separate from `channels`, which only carries per-channel overrides.
   */
  channelScope: Schema.optionalKey(AccessPolicy),
  channels: Schema.Array(DiscordGuildChannelConfig),
})
export type DiscordGuildConfig = typeof DiscordGuildConfig.Type

export const DiscordPlatformConfig = Schema.Struct({
  connectionId: PlatformConnectionId,
  platform: Schema.Literal('discord'),
  name: Identifier,
  credentials: Schema.Struct({
    botToken: SecretValue,
    applicationId: SecretValue,
    publicKey: SecretValue,
  }),
  respondToGlobalMentions: Schema.Boolean,
  mentionRoleIds: IdentifierArray,
  /**
   * Explicit opt-in for a global, public Discord application description containing
   * sanitized channel names and task labels.
   */
  activityDescription: Schema.Boolean,
  /** Connection-wide user permission default; DMs resolve against it directly. */
  users: AccessPolicy,
  guilds: Schema.Array(DiscordGuildConfig),
})
export type DiscordPlatformConfig = typeof DiscordPlatformConfig.Type

export const SlackPlatformConfig = Schema.Union([
  Schema.Struct({
    connectionId: PlatformConnectionId,
    platform: Schema.Literal('slack'),
    name: Identifier,
    mode: Schema.Literal('socket'),
    credentials: Schema.Struct({
      botToken: SecretValue,
      appToken: SecretValue,
      signingSecret: Schema.optionalKey(SecretValue),
    }),
    access: Schema.Struct({
      users: AccessPolicy,
      channels: AccessPolicy,
      workspaces: AccessPolicy,
    }),
  }),
  Schema.Struct({
    connectionId: PlatformConnectionId,
    platform: Schema.Literal('slack'),
    name: Identifier,
    mode: Schema.Literal('webhook'),
    credentials: Schema.Struct({
      botToken: SecretValue,
      signingSecret: SecretValue,
    }),
    access: Schema.Struct({
      users: AccessPolicy,
      channels: AccessPolicy,
      workspaces: AccessPolicy,
    }),
  }),
])
export type SlackPlatformConfig = typeof SlackPlatformConfig.Type

export const AdminConfig = Schema.Struct({
  /** Stable Discord user IDs permitted to run administrative application commands. */
  discordUserIds: IdentifierArray,
})
export type AdminConfig = typeof AdminConfig.Type

export const AppConfig = Schema.Struct({
  installationId: Identifier,
  models: Schema.Struct({
    primary: ConfiguredModel,
    utility: ConfiguredModel,
    subagents: Schema.Array(SubagentProfile),
  }),
  platforms: Schema.Struct({
    discord: Schema.Array(DiscordPlatformConfig),
    slack: Schema.Array(SlackPlatformConfig),
  }),
  /** Exact Discord conversation links. Absent on legacy in-memory fixtures. */
  discordLinks: Schema.optionalKey(Schema.Array(DiscordLink)),
  agent: Schema.Struct({
    recentMessageCount: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    ),
  }),
  admin: AdminConfig,
})
export type AppConfig = typeof AppConfig.Type

/** The Discord connection identity and resources that only restarts may change. */
export type DiscordConnectionTopology = Pick<
  DiscordPlatformConfig,
  | 'connectionId'
  | 'platform'
  | 'name'
  | 'credentials'
  | 'respondToGlobalMentions'
  | 'mentionRoleIds'
  | 'activityDescription'
>

/**
 * Merges a freshly validated configuration into the running snapshot for reload.
 *
 * Discord connection topology (identity, credentials, mention roles, application
 * description) is pinned to the running snapshot because Discord resources are built
 * once at startup; access policies, invocation policies, system channels, models,
 * and agent settings come from the loaded configuration. Discord connections that
 * are not currently running are ignored until restart, and the admin allow-list is
 * pinned so a database edit cannot lock administrators out of running reloads.
 */
export const mergeReloadedAppConfig = (running: AppConfig, loaded: AppConfig): AppConfig => ({
  ...loaded,
  platforms: {
    ...loaded.platforms,
    discord: running.platforms.discord.map((connection) => {
      const reloaded = loaded.platforms.discord.find(
        (candidate) => candidate.connectionId === connection.connectionId,
      )
      if (reloaded === undefined) return connection
      const topology: DiscordConnectionTopology = {
        connectionId: connection.connectionId,
        platform: connection.platform,
        name: connection.name,
        credentials: connection.credentials,
        respondToGlobalMentions: connection.respondToGlobalMentions,
        mentionRoleIds: connection.mentionRoleIds,
        activityDescription: connection.activityDescription,
      }
      return { ...reloaded, ...topology }
    }),
  },
  admin: running.admin,
})

/** Resolves one Discord connection from the current snapshot. */
export const findDiscordConnection = (
  configuration: AppConfig,
  connectionId: DiscordPlatformConfig['connectionId'],
): Option.Option<DiscordPlatformConfig> =>
  Option.fromNullishOr(
    configuration.platforms.discord.find((connection) => connection.connectionId === connectionId),
  )

export class AppConfigError extends Schema.Error<AppConfigError>('AppConfigError')({
  _tag: Schema.tag('AppConfigError'),
  operation: Schema.Literals(['read', 'decode', 'secret']),
  path: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Friday configuration ${this.operation} failed at ${this.path}: ${this.detail}`
  }
}

const InstallationRow = Schema.Struct({ installation_id: Schema.String })

const AdminUserRow = Schema.Struct({ user_id: Schema.String })

const AgentConfigRow = Schema.Struct({
  primary_provider: Schema.String,
  primary_model_id: Schema.String,
  primary_thinking_level: Schema.String,
  utility_provider: Schema.String,
  utility_model_id: Schema.String,
  utility_thinking_level: Schema.String,
  recent_message_count: Schema.Number,
})

const SubagentProfileRow = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  provider: Schema.String,
  model_id: Schema.String,
  thinking_level: Schema.String,
})

const DiscordConnectionRow = Schema.Struct({
  connection_id: Schema.String,
  name: Schema.String,
  application_id: Schema.String,
  public_key: Schema.String,
  bot_token_env: Schema.String,
  respond_to_global_mentions: Schema.Number,
  activity_description_public: Schema.Number,
})

const DiscordMentionRoleRow = Schema.Struct({
  connection_id: Schema.String,
  role_id: Schema.String,
})

const AccessPolicyRow = Schema.Struct({
  connection_id: Schema.String,
  subject_type: Schema.String,
  mode: Schema.Literals(['all', 'allow', 'deny']),
})

const AccessSubjectRow = Schema.Struct({
  connection_id: Schema.String,
  subject_type: Schema.String,
  platform_subject_id: Schema.String,
})

const GuildRow = Schema.Struct({
  connection_id: Schema.String,
  guild_id: Schema.String,
  enabled: Schema.Number,
  invocation_mode: InvocationMode,
  users_mode: Schema.NullOr(Schema.Literals(['all', 'allow', 'deny'])),
  channels_mode: Schema.NullOr(Schema.Literals(['all', 'allow', 'deny'])),
})

const GuildUserSubjectRow = Schema.Struct({
  connection_id: Schema.String,
  guild_id: Schema.String,
  user_id: Schema.String,
})

const GuildChannelRow = Schema.Struct({
  connection_id: Schema.String,
  guild_id: Schema.String,
  channel_id: Schema.String,
  invocation_mode: Schema.NullOr(InvocationMode),
  users_mode: Schema.NullOr(Schema.Literals(['all', 'allow', 'deny'])),
  reply_mode: Schema.NullOr(ReplyMode),
})

const GuildChannelUserSubjectRow = Schema.Struct({
  connection_id: Schema.String,
  guild_id: Schema.String,
  channel_id: Schema.String,
  user_id: Schema.String,
})

const GuildChannelScopeSubjectRow = Schema.Struct({
  connection_id: Schema.String,
  guild_id: Schema.String,
  channel_id: Schema.String,
})

const DiscordLinkRow = Schema.Struct({
  link_id: Schema.String,
  enabled: Schema.Number,
  source_connection_id: Schema.String,
  source_guild_id: Schema.String,
  source_conversation_id: Schema.String,
  source_kind: Schema.Literals(['channel', 'thread']),
  destination_connection_id: Schema.String,
  destination_guild_id: Schema.String,
  destination_conversation_id: Schema.String,
  destination_kind: Schema.Literal('channel'),
})

/**
 * Mutable assembly shapes for guild configuration read from SQLite: optional
 * policy sections attach only when their columns are configured.
 */
interface AssembledDiscordGuild {
  guildId: string
  enabled: boolean
  invocation: { defaultMode: InvocationMode }
  users?: AccessPolicy
  channelScope?: AccessPolicy
  channels: ReadonlyArray<DiscordGuildChannelConfig>
}

interface AssembledDiscordGuildChannel {
  channelId: string
  invocationMode?: InvocationMode
  users?: AccessPolicy
  replyMode?: ReplyMode
}

const decodeInstallationRows = Schema.decodeUnknownEffect(Schema.Array(InstallationRow))
const decodeAdminUserRows = Schema.decodeUnknownEffect(Schema.Array(AdminUserRow))
const decodeAgentConfigRows = Schema.decodeUnknownEffect(Schema.Array(AgentConfigRow))
const decodeSubagentProfileRows = Schema.decodeUnknownEffect(Schema.Array(SubagentProfileRow))
const decodeDiscordConnectionRows = Schema.decodeUnknownEffect(Schema.Array(DiscordConnectionRow))
const decodeDiscordMentionRoleRows = Schema.decodeUnknownEffect(Schema.Array(DiscordMentionRoleRow))
const decodeAccessPolicyRows = Schema.decodeUnknownEffect(Schema.Array(AccessPolicyRow))
const decodeAccessSubjectRows = Schema.decodeUnknownEffect(Schema.Array(AccessSubjectRow))
const decodeGuildRows = Schema.decodeUnknownEffect(Schema.Array(GuildRow))
const decodeGuildUserSubjectRows = Schema.decodeUnknownEffect(Schema.Array(GuildUserSubjectRow))
const decodeGuildChannelRows = Schema.decodeUnknownEffect(Schema.Array(GuildChannelRow))
const decodeGuildChannelUserSubjectRows = Schema.decodeUnknownEffect(
  Schema.Array(GuildChannelUserSubjectRow),
)
const decodeGuildChannelScopeSubjectRows = Schema.decodeUnknownEffect(
  Schema.Array(GuildChannelScopeSubjectRow),
)
const decodeDiscordLinkRows = Schema.decodeUnknownEffect(Schema.Array(DiscordLinkRow))
const decodeSecretValue = Schema.decodeUnknownEffect(SecretValue)
const decodeAppConfig = Schema.decodeUnknownEffect(AppConfig)

const readAllRows = Effect.fn('AppConfig.readAllRows')(function* () {
  const sql = yield* SqlClient.SqlClient
  const installationRows = yield* sql<Record<string, unknown>>`
    SELECT installation_id FROM installation_config WHERE id = 1
  `
  const installation = yield* decodeInstallationRows(installationRows).pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(
            new AppConfigError({
              operation: 'read',
              path: 'installation_config',
              detail: 'Friday installation identity has not been initialized.',
            }),
          )
        : Effect.succeed(rows[0]),
    ),
  )
  const agentRows = yield* sql<Record<string, unknown>>`SELECT * FROM agent_config WHERE id = 1`
  const agent = yield* decodeAgentConfigRows(agentRows).pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(
            new AppConfigError({
              operation: 'read',
              path: 'agent_config',
              detail: 'Friday configuration has not been initialized.',
            }),
          )
        : Effect.succeed(rows[0]),
    ),
  )
  const profiles = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM subagent_profiles ORDER BY name`
  const discord = yield* sql<Record<string, unknown>>`
    SELECT
      platform_connections.connection_id,
      platform_connections.name,
      discord_connections.application_id,
      discord_connections.public_key,
      discord_connections.bot_token_env,
      discord_connections.respond_to_global_mentions,
      discord_connections.activity_description_public
    FROM platform_connections
    JOIN discord_connections USING (connection_id)
    WHERE platform_connections.platform = 'discord'
      AND platform_connections.enabled = 1
    ORDER BY platform_connections.connection_id
  `
  const mentionRoles = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM discord_mention_roles ORDER BY connection_id, role_id`
  const policies = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM platform_access_policies ORDER BY connection_id, subject_type`
  const subjects = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM platform_access_subjects ORDER BY connection_id, subject_type, platform_subject_id`
  const guilds = yield* sql<Record<string, unknown>>`
    SELECT * FROM discord_guilds ORDER BY connection_id, guild_id
  `
  const guildUsers = yield* sql<Record<string, unknown>>`
    SELECT * FROM discord_guild_users ORDER BY connection_id, guild_id, user_id
  `
  const guildChannels = yield* sql<Record<string, unknown>>`
    SELECT * FROM discord_guild_channels ORDER BY connection_id, guild_id, channel_id
  `
  const guildChannelUsers = yield* sql<Record<string, unknown>>`
    SELECT * FROM discord_guild_channel_users
    ORDER BY connection_id, guild_id, channel_id, user_id
  `
  const guildChannelScope = yield* sql<Record<string, unknown>>`
    SELECT * FROM discord_guild_channel_scope
    ORDER BY connection_id, guild_id, channel_id
  `
  const links = yield* sql<Record<string, unknown>>`
    SELECT * FROM discord_links ORDER BY link_id
  `
  const adminUsers = yield* sql<
    Record<string, unknown>
  >`SELECT user_id FROM admin_discord_users ORDER BY user_id`
  return {
    installation,
    agent,
    profiles: yield* decodeSubagentProfileRows(profiles),
    discord: yield* decodeDiscordConnectionRows(discord),
    mentionRoles: yield* decodeDiscordMentionRoleRows(mentionRoles),
    policies: yield* decodeAccessPolicyRows(policies),
    subjects: yield* decodeAccessSubjectRows(subjects),
    guilds: yield* decodeGuildRows(guilds),
    guildUsers: yield* decodeGuildUserSubjectRows(guildUsers),
    guildChannels: yield* decodeGuildChannelRows(guildChannels),
    guildChannelUsers: yield* decodeGuildChannelUserSubjectRows(guildChannelUsers),
    guildChannelScope: yield* decodeGuildChannelScopeSubjectRows(guildChannelScope),
    links: yield* decodeDiscordLinkRows(links),
    adminUsers: yield* decodeAdminUserRows(adminUsers),
  }
})

const readRows = Effect.fn('AppConfig.readRows')(function* () {
  const sql = yield* SqlClient.SqlClient
  // One coherent snapshot: every configuration read runs inside a single
  // transaction so a concurrent writer can never produce a torn configuration
  // (e.g. policies read before a CLI write, subjects read after it).
  return yield* sql.withTransaction(readAllRows())
})

const resolveSecret = (
  environment: Readonly<Record<string, string | undefined>>,
  environmentName: string,
  path: string,
): Effect.Effect<SecretValue, AppConfigError> => {
  const value = environment[environmentName]
  return value === undefined || value.length === 0
    ? Effect.fail(
        new AppConfigError({
          operation: 'secret',
          path,
          detail: `Environment variable ${environmentName} is not set.`,
        }),
      )
    : decodeSecretValue(value).pipe(
        Effect.mapError(
          (cause) =>
            new AppConfigError({
              operation: 'secret',
              path,
              detail: `Environment variable ${environmentName} is empty.`,
              cause,
            }),
        ),
      )
}

const policyFor = (
  connectionId: string,
  subjectType: 'user' | 'workspace',
  policies: ReadonlyArray<typeof AccessPolicyRow.Type>,
  subjects: ReadonlyArray<typeof AccessSubjectRow.Type>,
): AccessPolicy => {
  const policy = policies.find(
    (candidate) =>
      candidate.connection_id === connectionId && candidate.subject_type === subjectType,
  )
  if (!policy) return { mode: 'all', ids: [] }
  return {
    mode: policy.mode,
    ids: subjects
      .filter(
        (subject) => subject.connection_id === connectionId && subject.subject_type === subjectType,
      )
      .map((subject) => subject.platform_subject_id),
  }
}

export const loadAppConfig = Effect.fn('loadAppConfig')(function* (options?: {
  readonly environment?: Readonly<Record<string, string | undefined>>
}) {
  const environment = options?.environment ?? process.env
  const rows = yield* readRows().pipe(
    Effect.mapError((cause) =>
      Schema.isSchemaError(cause)
        ? new AppConfigError({
            operation: 'decode',
            path: 'database',
            detail: 'Stored Friday configuration is invalid.',
            cause,
          })
        : cause,
    ),
  )
  const candidate = {
    installationId: rows.installation.installation_id,
    models: {
      primary: {
        provider: rows.agent.primary_provider,
        modelId: rows.agent.primary_model_id,
        thinkingLevel: rows.agent.primary_thinking_level,
      },
      utility: {
        provider: rows.agent.utility_provider,
        modelId: rows.agent.utility_model_id,
        thinkingLevel: rows.agent.utility_thinking_level,
      },
      subagents: rows.profiles.map((profile) => ({
        name: profile.name,
        description: profile.description,
        model: { provider: profile.provider, modelId: profile.model_id },
        thinkingLevel: profile.thinking_level,
      })),
    },
    platforms: {
      discord: yield* Effect.forEach(rows.discord, (connection) =>
        resolveSecret(
          environment,
          connection.bot_token_env,
          `platforms.${connection.connection_id}.credentials.botToken`,
        ).pipe(
          Effect.map((botToken) => ({
            connectionId: connection.connection_id,
            platform: 'discord',
            name: connection.name,
            credentials: {
              botToken,
              applicationId: connection.application_id,
              publicKey: connection.public_key,
            },
            users: policyFor(connection.connection_id, 'user', rows.policies, rows.subjects),
            respondToGlobalMentions: connection.respond_to_global_mentions === 1,
            activityDescription: connection.activity_description_public === 1,
            mentionRoleIds: rows.mentionRoles
              .filter((role) => role.connection_id === connection.connection_id)
              .map((role) => role.role_id),
            guilds: rows.guilds
              .filter((guild) => guild.connection_id === connection.connection_id)
              .map((guild) => {
                // Optional policy sections attach only when configured, so absent
                // fields keep inheriting from the enclosing scope.
                const guildEntry: AssembledDiscordGuild = {
                  guildId: guild.guild_id,
                  enabled: guild.enabled === 1,
                  invocation: { defaultMode: guild.invocation_mode },
                  channels: rows.guildChannels
                    .filter(
                      (channel) =>
                        channel.connection_id === guild.connection_id &&
                        channel.guild_id === guild.guild_id,
                    )
                    .map((channel) => {
                      const channelEntry: AssembledDiscordGuildChannel = {
                        channelId: channel.channel_id,
                      }
                      if (channel.invocation_mode !== null) {
                        channelEntry.invocationMode = channel.invocation_mode
                      }
                      if (channel.users_mode !== null) {
                        channelEntry.users = {
                          mode: channel.users_mode,
                          ids: rows.guildChannelUsers
                            .filter(
                              (subject) =>
                                subject.connection_id === channel.connection_id &&
                                subject.guild_id === channel.guild_id &&
                                subject.channel_id === channel.channel_id,
                            )
                            .map((subject) => subject.user_id),
                        }
                      }
                      if (channel.reply_mode !== null) {
                        channelEntry.replyMode = channel.reply_mode
                      }
                      return channelEntry
                    }),
                }
                if (guild.users_mode !== null) {
                  guildEntry.users = {
                    mode: guild.users_mode,
                    ids: rows.guildUsers
                      .filter(
                        (subject) =>
                          subject.connection_id === guild.connection_id &&
                          subject.guild_id === guild.guild_id,
                      )
                      .map((subject) => subject.user_id),
                  }
                }
                if (guild.channels_mode !== null) {
                  guildEntry.channelScope = {
                    mode: guild.channels_mode,
                    ids: rows.guildChannelScope
                      .filter(
                        (subject) =>
                          subject.connection_id === guild.connection_id &&
                          subject.guild_id === guild.guild_id,
                      )
                      .map((subject) => subject.channel_id),
                  }
                }
                return guildEntry
              }),
          })),
        ),
      ),
      slack: [],
    },
    discordLinks: rows.links.map((link) => ({
      id: link.link_id,
      enabled: link.enabled === 1,
      source: {
        connectionId: link.source_connection_id,
        guildId: link.source_guild_id,
        conversationId: link.source_conversation_id,
        kind: link.source_kind,
      },
      destination: {
        connectionId: link.destination_connection_id,
        guildId: link.destination_guild_id,
        conversationId: link.destination_conversation_id,
        kind: link.destination_kind,
      },
    })),
    agent: { recentMessageCount: rows.agent.recent_message_count },
    admin: {
      discordUserIds: rows.adminUsers.map((user) => user.user_id),
    },
  }
  return yield* decodeAppConfig(candidate).pipe(
    Effect.mapError(
      (cause) =>
        new AppConfigError({
          operation: 'decode',
          path: 'database',
          detail: 'Stored Friday configuration is invalid.',
          cause,
        }),
    ),
  )
})
