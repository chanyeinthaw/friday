import type { CliBranchSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'

export const worktreeCommand: CliBranchSpec = {
  name: 'worktree',
  summary: 'Manage repository worktrees registered with Friday.',
  children: [
    {
      name: 'ensure',
      summary: 'Ensure a reusable repository worktree for the current channel workspace.',
      arguments: [
        '<repository-url> [--ref <ref>] [--branch <branch>] [--workspace <path>] [--json]',
      ],
      parse: Parsing.parseWorktreeEnsure,
    },
    {
      name: 'list',
      summary: 'List repository worktrees registered with Friday.',
      arguments: ['[--json]'],
      parse: Parsing.parseWorktreeList,
    },
  ],
}
