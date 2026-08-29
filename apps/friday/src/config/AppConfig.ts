/* oxlint-disable eslint/no-underscore-dangle, effecttsgo/process-env -- Effect schema errors use the canonical _tag discriminator; the process environment is read at the configuration boundary. */

import { ModelSelection, SubagentProfileName, ThinkingLevel } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'

const Identifier = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))
const IdentifierArray = Schema.Array(Identifier)
const NonEmptyIdentifierArray = IdentifierArray.pipe(Schema.check(Schema.isNonEmpty()))

const AccessPolicyFile = Schema.Union([
  Schema.Struct({ mode: Schema.Literal('all') }),
  Schema.Struct({ mode: Schema.Literals(['allow', 'deny']), ids: NonEmptyIdentifierArray }),
])

const AccessPolicy = Schema.Struct({
  mode: Schema.Literals(['all', 'allow', 'deny']),
  ids: IdentifierArray,
})
export type AccessPolicy = typeof AccessPolicy.Type

export const SecretValue = Identifier.pipe(Schema.brand('SecretValue'))
export type SecretValue = typeof SecretValue.Type

const SecretReference = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

const DiscordCredentials = Schema.Struct({
  botToken: SecretReference,
  applicationId: SecretReference,
  publicKey: SecretReference,
})

const DiscordAccess = Schema.Struct({
  users: AccessPolicyFile,
  channels: AccessPolicyFile,
  guilds: AccessPolicyFile,
})

const DiscordPlatform = Schema.Struct({
  credentials: DiscordCredentials,
  access: DiscordAccess,
  respondToGlobalMentions: Schema.optionalKey(Schema.Boolean),
  mentionRoleIds: Schema.optionalKey(IdentifierArray),
})

const SlackSocketCredentials = Schema.Struct({
  botToken: SecretReference,
  appToken: SecretReference,
  signingSecret: Schema.optionalKey(SecretReference),
})

const SlackWebhookCredentials = Schema.Struct({
  botToken: SecretReference,
  signingSecret: SecretReference,
})

const SlackAccess = Schema.Struct({
  users: AccessPolicyFile,
  channels: AccessPolicyFile,
  workspaces: AccessPolicyFile,
})

const SlackPlatform = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal('socket'),
    credentials: SlackSocketCredentials,
    access: SlackAccess,
  }),
  Schema.Struct({
    mode: Schema.Literal('webhook'),
    credentials: SlackWebhookCredentials,
    access: SlackAccess,
  }),
])

export const SubagentProfile = Schema.Struct({
  name: SubagentProfileName,
  description: Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty())),
  model: ModelSelection,
  thinkingLevel: ThinkingLevel,
})
export type SubagentProfile = typeof SubagentProfile.Type

const Models = Schema.Struct({
  primary: ModelSelection,
  utility: Schema.optionalKey(ModelSelection),
  subagents: Schema.Array(SubagentProfile),
})

const Agent = Schema.Struct({
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
  recentMessageCount: Schema.optionalKey(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  ),
})

const Platforms = Schema.Struct({
  discord: Schema.optionalKey(DiscordPlatform),
  slack: Schema.optionalKey(SlackPlatform),
})

const AppConfigFileSchema = Schema.Struct({
  models: Models,
  platforms: Platforms,
  agent: Schema.optionalKey(Agent),
})

export type AppConfigFile = typeof AppConfigFileSchema.Type

const DiscordPlatformConfigSchema = Schema.Struct({
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
})

const SlackPlatformConfigSchema = Schema.Union([
  Schema.Struct({
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

const AppConfigSchema = Schema.Struct({
  models: Models,
  platforms: Schema.Struct({
    discord: Schema.optionalKey(DiscordPlatformConfigSchema),
    slack: Schema.optionalKey(SlackPlatformConfigSchema),
  }),
  agent: Schema.Struct({
    thinkingLevel: ThinkingLevel,
    recentMessageCount: Schema.Int.pipe(
      Schema.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
    ),
  }),
})

export type AppConfig = typeof AppConfigSchema.Type
export type DiscordPlatformConfig = typeof DiscordPlatformConfigSchema.Type
export type SlackPlatformConfig = typeof SlackPlatformConfigSchema.Type

export type AppConfigOperation = 'read' | 'decode' | 'secret'

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

const AppConfigFileJson = Schema.fromJsonString(AppConfigFileSchema)
const decodeAppConfigJson = Schema.decodeUnknownEffect(AppConfigFileJson)
const decodeSecretValue = Schema.decodeUnknownEffect(SecretValue)

const defaultThinkingLevel = 'max'
const defaultRecentMessageCount = 20

const makeConfiguredPlatforms = (
  discord: DiscordPlatformConfig | undefined,
  slack: SlackPlatformConfig | undefined,
): AppConfig['platforms'] => {
  if (discord !== undefined && slack !== undefined) return { discord, slack }
  if (discord !== undefined) return { discord }
  if (slack !== undefined) return { slack }
  return {}
}

const isNotFound = (cause: PlatformError.PlatformError): boolean => cause.reason._tag === 'NotFound'

const resolveSecret = (
  value: string,
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<SecretValue, AppConfigError> => {
  const trimmed = value.trim()
  const reference =
    trimmed.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/)?.[1] ??
    trimmed.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] ??
    trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1]
  if (reference !== undefined) {
    const resolved = environment[reference]
    return resolved === undefined || resolved.length === 0
      ? Effect.fail(
          new AppConfigError({
            operation: 'secret',
            path,
            detail: `Environment variable ${reference} is not set.`,
          }),
        )
      : decodeSecretValue(resolved).pipe(
          Effect.mapError(
            (cause) =>
              new AppConfigError({
                operation: 'secret',
                path,
                detail: `Environment variable ${reference} is empty.`,
                cause,
              }),
          ),
        )
  }
  if (trimmed.startsWith('env:') || trimmed.startsWith('$')) {
    return Effect.fail(
      new AppConfigError({
        operation: 'secret',
        path,
        detail: 'Secret references must use $NAME, ${NAME}, or env:NAME syntax.',
      }),
    )
  }
  return decodeSecretValue(value).pipe(
    Effect.mapError(
      (cause) =>
        new AppConfigError({
          operation: 'secret',
          path,
          detail: 'Secret value must not be empty.',
          cause,
        }),
    ),
  )
}

const resolveOptionalSecret = (
  value: string | undefined,
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<SecretValue | undefined, AppConfigError> =>
  value === undefined ? Effect.as(Effect.void, undefined) : resolveSecret(value, path, environment)

const normalizeAccessPolicy = (policy: typeof AccessPolicyFile.Type): AccessPolicy =>
  policy.mode === 'all' ? { mode: 'all', ids: [] } : { mode: policy.mode, ids: policy.ids }

const decodeConfig = (
  file: AppConfigFile,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<AppConfig, AppConfigError> => {
  const discord = file.platforms.discord
  const slack = file.platforms.slack
  return Effect.gen(function* () {
    let resolvedDiscord: DiscordPlatformConfig | undefined
    if (discord) {
      const credentials = {
        botToken: yield* resolveSecret(
          discord.credentials.botToken,
          'platforms.discord.credentials.botToken',
          environment,
        ),
        applicationId: yield* resolveSecret(
          discord.credentials.applicationId,
          'platforms.discord.credentials.applicationId',
          environment,
        ),
      }
      const publicKey = yield* resolveSecret(
        discord.credentials.publicKey,
        'platforms.discord.credentials.publicKey',
        environment,
      )
      resolvedDiscord = {
        credentials: { ...credentials, publicKey },
        access: {
          users: normalizeAccessPolicy(discord.access.users),
          channels: normalizeAccessPolicy(discord.access.channels),
          guilds: normalizeAccessPolicy(discord.access.guilds),
        },
        respondToGlobalMentions: discord.respondToGlobalMentions ?? false,
        mentionRoleIds: discord.mentionRoleIds ?? [],
      }
    }
    let resolvedSlack: SlackPlatformConfig | undefined
    if (slack?.mode === 'socket') {
      const botToken = yield* resolveSecret(
        slack.credentials.botToken,
        'platforms.slack.credentials.botToken',
        environment,
      )
      const appToken = yield* resolveSecret(
        slack.credentials.appToken,
        'platforms.slack.credentials.appToken',
        environment,
      )
      const signingSecret = yield* resolveOptionalSecret(
        slack.credentials.signingSecret,
        'platforms.slack.credentials.signingSecret',
        environment,
      )
      resolvedSlack = {
        mode: 'socket',
        credentials:
          signingSecret === undefined
            ? { botToken, appToken }
            : { botToken, appToken, signingSecret },
        access: {
          users: normalizeAccessPolicy(slack.access.users),
          channels: normalizeAccessPolicy(slack.access.channels),
          workspaces: normalizeAccessPolicy(slack.access.workspaces),
        },
      }
    } else if (slack?.mode === 'webhook') {
      const botToken = yield* resolveSecret(
        slack.credentials.botToken,
        'platforms.slack.credentials.botToken',
        environment,
      )
      const signingSecret = yield* resolveSecret(
        slack.credentials.signingSecret,
        'platforms.slack.credentials.signingSecret',
        environment,
      )
      resolvedSlack = {
        mode: 'webhook',
        credentials: { botToken, signingSecret },
        access: {
          users: normalizeAccessPolicy(slack.access.users),
          channels: normalizeAccessPolicy(slack.access.channels),
          workspaces: normalizeAccessPolicy(slack.access.workspaces),
        },
      }
    }
    return {
      models: {
        primary: file.models.primary,
        utility: file.models.utility ?? file.models.primary,
        subagents: file.models.subagents,
      },
      platforms: makeConfiguredPlatforms(resolvedDiscord, resolvedSlack),
      agent: {
        thinkingLevel: file.agent?.thinkingLevel ?? defaultThinkingLevel,
        recentMessageCount: file.agent?.recentMessageCount ?? defaultRecentMessageCount,
      },
    }
  })
}

export interface LoadAppConfigOptions {
  readonly path: string
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export const loadAppConfig = Effect.fn('loadAppConfig')(function* (
  options: LoadAppConfigOptions,
): Effect.fn.Return<AppConfig, AppConfigError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem
  const environment = options.environment ?? process.env
  const source = yield* fileSystem.readFileString(options.path).pipe(
    Effect.mapError(
      (cause) =>
        new AppConfigError({
          operation: 'read',
          path: options.path,
          detail: isNotFound(cause)
            ? 'Friday configuration file was not found.'
            : 'Friday configuration file could not be read.',
          cause,
        }),
    ),
  )
  const file = yield* decodeAppConfigJson(source).pipe(
    Effect.mapError(
      (cause) =>
        new AppConfigError({
          operation: 'decode',
          path: options.path,
          detail: 'Friday configuration is not valid JSON or does not match the expected schema.',
          cause,
        }),
    ),
  )
  return yield* decodeConfig(file, environment)
})
