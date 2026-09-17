import type { CliBranchSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'

export const modelCommand: CliBranchSpec = {
  name: 'model',
  summary: "Inspect and locally reload Pi's model catalog and auth state.",
  children: [
    {
      name: 'list',
      summary: 'List Pi catalog models without exposing credentials.',
      arguments: ['[--provider <provider>] [--available] [--json]'],
      parse: Parsing.parseModelList,
    },
    {
      name: 'get',
      summary: 'Show one Pi catalog model.',
      arguments: ['<provider> <model-id> [--json]'],
      parse: Parsing.parseModelGet,
    },
    {
      name: 'reload',
      summary: 'Reload Pi catalog and auth state locally, without network access.',
      parse: Parsing.parseModelReload,
    },
  ],
}
