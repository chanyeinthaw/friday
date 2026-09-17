import type { CliCommandSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'

export const discordConfigCommands: ReadonlyArray<CliCommandSpec> = [
  {
    name: 'discord',
    summary: 'Manage Discord connections and their guilds.',
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
            parse: Parsing.parseConfigDiscordConnectionAdd,
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
            parse: Parsing.parseConfigDiscordConnectionUpdate,
          },
          {
            name: 'remove',
            summary: 'Remove a connection and its Discord configuration (needs a restart).',
            arguments: ['<connection-id> --yes'],
            parse: Parsing.parseConfigDiscordConnectionRemove,
          },
          {
            name: 'enable',
            summary: 'Enable a configured connection (needs a restart).',
            arguments: ['<connection-id>'],
            parse: Parsing.parseConnectionEnableDisable(true),
          },
          {
            name: 'disable',
            summary: 'Disable a configured connection (needs a restart).',
            arguments: ['<connection-id>'],
            parse: Parsing.parseConnectionEnableDisable(false),
          },
          {
            name: 'get',
            summary: "Show one connection's stored configuration.",
            arguments: ['<connection-id> [--json]'],
            parse: Parsing.parseConfigDiscordConnectionGet,
          },
          {
            name: 'list',
            summary: 'List configured Discord connections.',
            arguments: ['[--json]'],
            parse: Parsing.parseConnectionList,
          },
        ],
      },
      {
        name: 'guild',
        summary: 'Manage guild policy; resident Discord connections pick up changes after reload.',
        children: [
          {
            name: 'enable',
            summary: 'Enable Friday in a guild.',
            arguments: ['<connection-id> <guild-id>'],
            parse: Parsing.parseConfigDiscordGuildEnable,
          },
          {
            name: 'disable',
            summary: 'Disable Friday in a guild.',
            arguments: ['<connection-id> <guild-id>'],
            parse: Parsing.parseConfigDiscordGuildDisable,
          },
          {
            name: 'remove',
            summary: "Remove a guild's configuration and its channel overrides.",
            arguments: ['<connection-id> <guild-id> --yes'],
            parse: Parsing.parseConfigDiscordGuildRemove,
          },
          {
            name: 'list',
            summary: "List a connection's guild configuration.",
            arguments: ['<connection-id> [--json]'],
            parse: Parsing.parseConfigDiscordGuildList,
          },
          {
            name: 'set-invocation',
            summary: 'Set the guild-wide invocation default.',
            arguments: ['<connection-id> <guild-id> <mention-only|all-messages>'],
            parse: Parsing.parseConfigDiscordGuildSetInvocation,
          },
          {
            name: 'set-users',
            summary: 'Set the guild-wide user permission default.',
            arguments: ['<connection-id> <guild-id> <all|allow=<id>[,...]|deny=<id>[,...]>'],
            parse: Parsing.parseConfigDiscordGuildSetUsers,
          },
          {
            name: 'set-channels',
            summary: 'Set the guild channel scope: which channels admit Friday at all.',
            arguments: ['<connection-id> <guild-id> <all|allow=<id>[,...]|deny=<id>[,...]>'],
            parse: Parsing.parseConfigDiscordGuildSetChannels,
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
                parse: Parsing.parseConfigDiscordGuildChannelSet,
              },
              {
                name: 'reset',
                summary: 'Remove channel overrides; guild defaults apply again.',
                arguments: ['<connection-id> <guild-id> <channel-id>'],
                parse: Parsing.parseConfigDiscordGuildChannelReset,
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
    ],
  },
]
