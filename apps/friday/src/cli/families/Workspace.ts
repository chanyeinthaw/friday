import type { CliBranchSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'

export const workspaceCommand: CliBranchSpec = {
  name: 'workspace',
  summary: 'Manage channel workspaces and their cleanup proposals.',
  children: [
    {
      name: 'cleanup',
      summary: 'Apply or inspect workspace cleanup proposals.',
      children: [
        {
          name: 'apply',
          summary: 'Apply an approved workspace cleanup proposal.',
          arguments: ['<proposal-id> [--json]'],
          parse: Parsing.parseWorkspaceCleanupApply,
        },
        {
          name: 'list',
          summary: 'List recorded workspace cleanup proposals.',
          arguments: ['[--json]'],
          parse: Parsing.parseWorkspaceCleanupList,
        },
      ],
    },
  ],
}
