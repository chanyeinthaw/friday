import type { CliCommandSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'

export const slackConfigCommands: ReadonlyArray<CliCommandSpec> = [
  {
    name: 'slack',
    summary: 'Manage Slack Socket Mode connections and their access policy.',
    children: [
      {
        name: 'connection',
        summary: "Manage one bot connection's stored topology (changes need a restart).",
        children: [
          {
            name: 'add',
            summary: 'Add a Slack Socket Mode connection (needs a restart).',
            arguments: [
              '<connection-id> --name <name> --bot-token-env <env-name>',
              '--app-token-env <env-name> [--reply-in-thread|--reply-in-channel]',
            ],
            parse: Parsing.parseConfigSlackConnectionAdd,
          },
          {
            name: 'update',
            summary:
              'Update stored connection fields, preserving the rest (changes need a restart).',
            arguments: [
              '<connection-id> [--name <name>] [--bot-token-env <env-name>]',
              '[--app-token-env <env-name>] [--reply-in-thread|--reply-in-channel]',
            ],
            parse: Parsing.parseConfigSlackConnectionUpdate,
          },
          {
            name: 'remove',
            summary: 'Remove a connection and its Slack configuration (needs a restart).',
            arguments: ['<connection-id> --yes'],
            parse: Parsing.parseConfigSlackConnectionRemove,
          },
          {
            name: 'enable',
            summary: 'Enable a configured connection (needs a restart).',
            arguments: ['<connection-id>'],
            parse: Parsing.parseSlackConnectionEnableDisable(true),
          },
          {
            name: 'disable',
            summary: 'Disable a configured connection (needs a restart).',
            arguments: ['<connection-id>'],
            parse: Parsing.parseSlackConnectionEnableDisable(false),
          },
          {
            name: 'get',
            summary: "Show one connection's stored configuration.",
            arguments: ['<connection-id> [--json]'],
            parse: Parsing.parseConfigSlackConnectionGet,
          },
          {
            name: 'list',
            summary: 'List configured Slack connections.',
            arguments: ['[--json]'],
            parse: Parsing.parseConfigSlackConnectionList,
          },
        ],
      },
      {
        name: 'access',
        summary:
          'Manage connection access policy; resident Slack connections pick up changes after reload.',
        children: [
          {
            name: 'set-users',
            summary: 'Set the connection-wide user permission policy.',
            arguments: ['<connection-id> <all|allow=<id>[,...]|deny=<id>[,...]>'],
            parse: Parsing.parseConfigSlackAccessSet('users'),
          },
          {
            name: 'set-channels',
            summary: 'Set the connection-wide channel admission policy.',
            arguments: ['<connection-id> <all|allow=<id>[,...]|deny=<id>[,...]>'],
            parse: Parsing.parseConfigSlackAccessSet('channels'),
          },
          {
            name: 'set-workspaces',
            summary: 'Set the connection-wide workspace admission policy.',
            arguments: ['<connection-id> <all|allow=<id>[,...]|deny=<id>[,...]>'],
            parse: Parsing.parseConfigSlackAccessSet('workspaces'),
          },
        ],
      },
      {
        name: 'channel',
        summary: 'Override the connection reply and invocation defaults for a single channel.',
        children: [
          {
            name: 'set',
            summary: 'Set the channel reply-mode and invocation-mode overrides.',
            arguments: [
              '<connection-id> <channel-id> [--reply-in-thread|--reply-in-channel]',
              '[--invocation <mention-only|all-messages>]',
            ],
            parse: Parsing.parseConfigSlackChannelSet,
          },
          {
            name: 'reset',
            summary: 'Remove the channel override; the connection default applies again.',
            arguments: ['<connection-id> <channel-id>'],
            parse: Parsing.parseConfigSlackChannelReset,
          },
        ],
      },
    ],
  },
]
