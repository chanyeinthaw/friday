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

export const DiscordPlatformConfig = Schema.Struct({
  connectionId: PlatformConnectionId,
  platform: Schema.Literal('discord'),
  name: Identifier,
  credentials: Schema.Struct({
    botToken: SecretValue,
    applicationId: SecretValue,
    publicKey: SecretValue,
  }),
  access: Schema.Struct({
    users: AccessPolicy,
    channels: AccessPolicy,
    guilds: AccessPolicy,
  }),
  respondToGlobalMentions: Schema.Boolean,
  mentionRoleIds: IdentifierArray,
  /**
   * Explicit opt-in for a global, public Discord application description containing
   * sanitized channel names and task labels.
   */
  activityDescription: Schema.Boolean,
  invocation: Schema.Struct({
    defaultMode: InvocationMode,
    channels: Schema.Array(Schema.Struct({ channelId: Identifier, mode: InvocationMode })),
  }),
  systemChannelIds: IdentifierArray,
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

const InvocationDefaultRow = Schema.Struct({
  connection_id: Schema.String,
  mode: InvocationMode,
})

const ChannelInvocationRow = Schema.Struct({
  connection_id: Schema.String,
  channel_id: Schema.String,
  mode: InvocationMode,
})

const SystemChannelRow = Schema.Struct({
  connection_id: Schema.String,
  channel_id: Schema.String,
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

const decodeInstallationRows = Schema.decodeUnknownEffect(Schema.Array(InstallationRow))
const decodeAdminUserRows = Schema.decodeUnknownEffect(Schema.Array(AdminUserRow))
const decodeAgentConfigRows = Schema.decodeUnknownEffect(Schema.Array(AgentConfigRow))
const decodeSubagentProfileRows = Schema.decodeUnknownEffect(Schema.Array(SubagentProfileRow))
const decodeDiscordConnectionRows = Schema.decodeUnknownEffect(Schema.Array(DiscordConnectionRow))
const decodeInvocationDefaultRows = Schema.decodeUnknownEffect(Schema.Array(InvocationDefaultRow))
const decodeChannelInvocationRows = Schema.decodeUnknownEffect(Schema.Array(ChannelInvocationRow))
const decodeSystemChannelRows = Schema.decodeUnknownEffect(Schema.Array(SystemChannelRow))
const decodeDiscordMentionRoleRows = Schema.decodeUnknownEffect(Schema.Array(DiscordMentionRoleRow))
const decodeAccessPolicyRows = Schema.decodeUnknownEffect(Schema.Array(AccessPolicyRow))
const decodeAccessSubjectRows = Schema.decodeUnknownEffect(Schema.Array(AccessSubjectRow))
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
  const invocationDefaults = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM platform_invocation_defaults ORDER BY connection_id`
  const channelInvocations = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM platform_channel_invocation_policies ORDER BY connection_id, channel_id`
  const systemChannels = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM platform_system_channels ORDER BY connection_id, channel_id`
  const mentionRoles = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM discord_mention_roles ORDER BY connection_id, role_id`
  const policies = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM platform_access_policies ORDER BY connection_id, subject_type`
  const subjects = yield* sql<
    Record<string, unknown>
  >`SELECT * FROM platform_access_subjects ORDER BY connection_id, subject_type, platform_subject_id`
  const adminUsers = yield* sql<
    Record<string, unknown>
  >`SELECT user_id FROM admin_discord_users ORDER BY user_id`
  return {
    installation,
    agent,
    profiles: yield* decodeSubagentProfileRows(profiles),
    discord: yield* decodeDiscordConnectionRows(discord),
    invocationDefaults: yield* decodeInvocationDefaultRows(invocationDefaults),
    channelInvocations: yield* decodeChannelInvocationRows(channelInvocations),
    systemChannels: yield* decodeSystemChannelRows(systemChannels),
    mentionRoles: yield* decodeDiscordMentionRoleRows(mentionRoles),
    policies: yield* decodeAccessPolicyRows(policies),
    subjects: yield* decodeAccessSubjectRows(subjects),
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
  subjectType: 'user' | 'channel' | 'guild' | 'workspace',
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
            access: {
              users: policyFor(connection.connection_id, 'user', rows.policies, rows.subjects),
              channels: policyFor(
                connection.connection_id,
                'channel',
                rows.policies,
                rows.subjects,
              ),
              guilds: policyFor(connection.connection_id, 'guild', rows.policies, rows.subjects),
            },
            respondToGlobalMentions: connection.respond_to_global_mentions === 1,
            activityDescription: connection.activity_description_public === 1,
            mentionRoleIds: rows.mentionRoles
              .filter((role) => role.connection_id === connection.connection_id)
              .map((role) => role.role_id),
            invocation: {
              defaultMode:
                rows.invocationDefaults.find(
                  (policy) => policy.connection_id === connection.connection_id,
                )?.mode ?? 'mention-only',
              channels: rows.channelInvocations
                .filter((policy) => policy.connection_id === connection.connection_id)
                .map((policy) => ({ channelId: policy.channel_id, mode: policy.mode })),
            },
            systemChannelIds: rows.systemChannels
              .filter((channel) => channel.connection_id === connection.connection_id)
              .map((channel) => channel.channel_id),
          })),
        ),
      ),
      slack: [],
    },
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
