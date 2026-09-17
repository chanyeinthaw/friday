import type { CliCommandSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'

export const identityConfigCommands: ReadonlyArray<CliCommandSpec> = [
  {
    name: 'admin',
    summary: "Manage Friday's administrator allow-list (changes need a restart).",
    children: [
      {
        name: 'discord',
        summary: 'Manage the Discord administrator allow-list.',
        children: [
          {
            name: 'add',
            summary: 'Add a Discord administrator.',
            arguments: ['<user-id>'],
            parse: Parsing.parseAdminDiscordAdd,
          },
          {
            name: 'remove',
            summary: 'Remove a Discord administrator.',
            arguments: ['<user-id>'],
            parse: Parsing.parseAdminDiscordRemove,
          },
          {
            name: 'list',
            summary: 'List configured Discord administrators.',
            arguments: ['[--json]'],
            parse: Parsing.parseAdminDiscordList,
          },
        ],
      },
    ],
  },
  {
    name: 'identity',
    summary: 'View or set the trusted channel-agent identity text.',
    children: [
      {
        name: 'get',
        summary: 'Show the configured channel-agent identity text.',
        arguments: ['[--json]'],
        parse: Parsing.parseIdentityGet,
      },
      {
        name: 'set',
        summary: 'Set the channel-agent identity text literally.',
        arguments: ['<text>'],
        parse: Parsing.parseIdentitySet,
      },
    ],
  },
  {
    name: 'root-user',
    summary: 'Manage root users by platform plus guild/workspace scope (applies live).',
    children: [
      {
        name: 'add',
        summary: 'Register a root user for a platform scope.',
        arguments: ['<discord|slack> <scope-id> <user-id>'],
        parse: Parsing.parseRootUserAdd,
      },
      {
        name: 'remove',
        summary: 'Remove a root user from a platform scope.',
        arguments: ['<discord|slack> <scope-id> <user-id>'],
        parse: Parsing.parseRootUserRemove,
      },
      {
        name: 'list',
        summary: 'List configured root users.',
        arguments: ['[--json]'],
        parse: Parsing.parseRootUserList,
      },
    ],
  },
]
