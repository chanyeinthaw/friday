import type { CliCommandSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'

export const modelConfigCommands: ReadonlyArray<CliCommandSpec> = [
  {
    name: 'model',
    summary: "Manage Friday's fixed primary and utility model selections.",
    children: [
      {
        name: 'list',
        summary: 'List fixed model selections.',
        arguments: ['[--json]'],
        parse: Parsing.parseConfigModelList,
      },
      {
        name: 'get',
        summary: 'Show one fixed model selection.',
        arguments: ['<primary|utility> [--json]'],
        parse: Parsing.parseConfigModelGet,
      },
      {
        name: 'set',
        summary: 'Set one fixed model selection and reload configuration.',
        arguments: [
          '<primary|utility> --provider <provider> --model-id <model-id>',
          '--thinking <off|minimal|low|medium|high|xhigh|max>',
        ],
        parse: Parsing.parseConfigModelSet,
      },
    ],
  },
  {
    name: 'profile',
    summary: 'Manage Friday subagent profiles.',
    children: [
      {
        name: 'list',
        summary: 'List subagent profiles.',
        arguments: ['[--json]'],
        parse: Parsing.parseConfigProfileList,
      },
      {
        name: 'get',
        summary: 'Show one subagent profile.',
        arguments: ['<name> [--json]'],
        parse: Parsing.parseConfigProfileGet,
      },
      {
        name: 'add',
        summary: 'Add a subagent profile and reload configuration.',
        arguments: [
          '<name> --description <description> --provider <provider>',
          '--model-id <model-id> --thinking <level>',
        ],
        parse: Parsing.parseConfigProfileAdd,
      },
      {
        name: 'update',
        summary: 'Update given subagent profile fields and reload configuration.',
        arguments: [
          '<name> [--description <description>] [--provider <provider>]',
          '[--model-id <model-id>] [--thinking <level>]',
        ],
        parse: Parsing.parseConfigProfileUpdate,
      },
      {
        name: 'remove',
        summary: 'Remove a subagent profile. The primary profile is protected.',
        arguments: ['<name> --yes'],
        parse: Parsing.parseConfigProfileRemove,
      },
    ],
  },
]
