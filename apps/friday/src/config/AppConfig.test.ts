import { assert, it } from '@effect/vitest'
import { ModelSelection } from '@friday/contracts/conversation'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import * as Schema from 'effect/Schema'

import { AppConfigError, loadAppConfig, type AppConfig } from './AppConfig.ts'

const configJson = `{
  "models": {
    "primary": {
      "provider": "opencode-go",
      "modelId": "deepseek-v4-flash"
    },
    "subagents": [
      {
        "name": "primary",
        "description": "General delegated work.",
        "model": {
          "provider": "anthropic",
          "modelId": "claude-sonnet"
        },
        "thinkingLevel": "max"
      }
    ]
  },
  "platforms": {
    "discord": {
      "credentials": {
        "botToken": "env:DISCORD_BOT_TOKEN",
        "applicationId": "literal-application-id",
        "publicKey": "$DISCORD_PUBLIC_KEY"
      },
      "allowlist": {
        "channelIds": ["channel-1"],
        "guildIds": ["guild-1"],
        "userIds": ["user-1"]
      }
    },
    "slack": {
      "mode": "socket",
      "credentials": {
        "botToken": "literal-slack-token",
        "appToken": "env:SLACK_APP_TOKEN"
      },
      "allowlist": {
        "channelIds": ["C123"],
        "workspaceIds": ["T123"],
        "userIds": ["U123"]
      }
    }
  },
  "agent": {
    "thinkingLevel": "high",
    "recentMessageCount": 5
  }
}`

const isAppConfigError = Schema.is(AppConfigError)
const decodeModelSelection = Schema.decodeSync(ModelSelection)

const makeFileSystem = (content: string | undefined) =>
  FileSystem.makeNoop({
    readFileString: () =>
      content === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: 'NotFound',
              module: 'test',
              method: 'readFileString',
              pathOrDescriptor: 'friday.json',
            }),
          )
        : Effect.succeed(content),
  })

const load = (
  content: string | undefined,
  environment: Readonly<Record<string, string | undefined>> = {},
) =>
  loadAppConfig({ path: 'friday.json', environment }).pipe(
    Effect.provideService(FileSystem.FileSystem, makeFileSystem(content)),
  )

it.effect('loads literal and environment-backed secrets and preserves model pools', () =>
  Effect.gen(function* () {
    const config = yield* load(configJson, {
      DISCORD_BOT_TOKEN: 'discord-token',
      DISCORD_PUBLIC_KEY: 'discord-public-key',
      SLACK_APP_TOKEN: 'slack-app-token',
    })

    assert.strictEqual(config.models.primary.provider, 'opencode-go')
    assert.strictEqual(config.models.primary.modelId, 'deepseek-v4-flash')
    const discord = config.platforms.discord
    assert(discord !== undefined)
    assert.strictEqual(config.models.subagents.length, 1)
    assert.strictEqual(config.models.subagents[0]?.name, 'primary')
    assert.strictEqual(config.models.subagents[0]?.description, 'General delegated work.')
    assert.strictEqual(config.models.subagents[0]?.model.provider, 'anthropic')
    assert.strictEqual(config.models.subagents[0]?.model.modelId, 'claude-sonnet')
    assert.strictEqual(config.models.subagents[0]?.thinkingLevel, 'max')
    assert.strictEqual(discord.credentials.botToken, 'discord-token')
    assert.strictEqual(discord.credentials.applicationId, 'literal-application-id')
    assert.strictEqual(discord.credentials.publicKey, 'discord-public-key')
    assert.deepStrictEqual(discord.allowlist, {
      channelIds: ['channel-1'],
      guildIds: ['guild-1'],
      userIds: ['user-1'],
    })
    const slack = config.platforms.slack
    assert(slack !== undefined)
    assert.strictEqual(slack.mode, 'socket')
    if (slack.mode !== 'socket') return
    assert.strictEqual(slack.credentials.appToken, 'slack-app-token')
    assert.strictEqual(config.agent.thinkingLevel, 'high')
    assert.strictEqual(config.agent.recentMessageCount, 5)
  }),
)

it.effect('uses safe defaults for optional agent settings', () =>
  Effect.gen(function* () {
    const config = yield* load(
      configJson.replace(
        ',\n  "agent": {\n    "thinkingLevel": "high",\n    "recentMessageCount": 5\n  }',
        '',
      ),
      {
        DISCORD_BOT_TOKEN: 'discord-token',
        DISCORD_PUBLIC_KEY: 'discord-public-key',
        SLACK_APP_TOKEN: 'slack-app-token',
      },
    )

    assert.strictEqual(config.agent.thinkingLevel, 'max')
    assert.strictEqual(config.agent.recentMessageCount, 20)
  }),
)

it.effect('fails without leaking a missing secret value', () =>
  Effect.gen(function* () {
    const exit = yield* load(configJson, {
      DISCORD_PUBLIC_KEY: 'discord-public-key',
      SLACK_APP_TOKEN: 'slack-app-token',
    }).pipe(Effect.exit)

    if (!Exit.isFailure(exit)) return
    const error = Cause.squash(exit.cause)
    assert(isAppConfigError(error))
    assert.strictEqual(error.operation, 'secret')
    assert.strictEqual(error.path, 'platforms.discord.credentials.botToken')
    assert(error.detail.includes('DISCORD_BOT_TOKEN'))
    assert(!error.detail.includes('discord-token'))
  }),
)

it.effect('reports a missing configuration file', () =>
  Effect.gen(function* () {
    const exit = yield* load(undefined).pipe(Effect.exit)

    if (!Exit.isFailure(exit)) return
    const error = Cause.squash(exit.cause)
    assert(isAppConfigError(error))
    assert.strictEqual(error.operation, 'read')
    assert.strictEqual(error.path, 'friday.json')
    assert.strictEqual(error.detail, 'Friday configuration file was not found.')
  }),
)

it.effect('reports malformed configuration without exposing credential contents', () =>
  Effect.gen(function* () {
    const exit = yield* load(
      '{"models":{"primary":{"provider":"opencode-go","modelId":42},"subagents":[]}}',
    ).pipe(Effect.exit)

    if (!Exit.isFailure(exit)) return
    const error = Cause.squash(exit.cause)
    assert(isAppConfigError(error))
    assert.strictEqual(error.operation, 'decode')
    assert.strictEqual(error.path, 'friday.json')
    assert.strictEqual(
      error.detail,
      'Friday configuration is not valid JSON or does not match the expected schema.',
    )
  }),
)

const typeCheck = (config: AppConfig): void => {
  void config
  void decodeModelSelection({
    provider: 'opencode-go',
    modelId: 'deepseek-v4-flash',
  })
}
void typeCheck
