import type { CliBranchSpec } from '../Command.ts'
import * as Parsing from '../Parsing.ts'

export const documentCommand: CliBranchSpec = {
  name: 'document',
  summary: 'Publish and manage private Markdown or HTML documents.',
  children: [
    {
      name: 'save',
      summary:
        'Save stdin or --file content under a key, overwriting in place and keeping its URL.',
      arguments: ['<key> [--format <markdown|html>] [--file <path>] [--json]'],
      parse: Parsing.parseDocumentSave,
    },
    {
      name: 'get',
      summary: 'Show one stored document without its URL.',
      arguments: ['<key> [--json]'],
      parse: Parsing.parseDocumentGet,
    },
    {
      name: 'list',
      summary: 'List published documents without their URLs.',
      arguments: ['[--json]'],
      parse: Parsing.parseDocumentList,
    },
    {
      name: 'url',
      summary: 'Recover the current secret URL for a key.',
      arguments: ['<key> [--json]'],
      parse: Parsing.parseDocumentUrl,
    },
    {
      name: 'revoke',
      summary: 'Replace the access key and return a new URL; the old URL stops working.',
      arguments: ['<key> [--json]'],
      parse: Parsing.parseDocumentRevoke,
    },
    {
      name: 'remove',
      summary: 'Delete a document; its URL stops working.',
      arguments: ['<key> --yes'],
      parse: Parsing.parseDocumentRemove,
    },
    {
      name: 'config',
      summary: 'Inspect or change document server configuration.',
      children: [
        {
          name: 'get',
          summary: 'Show document server configuration.',
          arguments: ['[--json]'],
          parse: Parsing.parseDocumentConfigGet,
        },
        {
          name: 'set',
          summary: 'Change document server configuration; listener changes need a restart.',
          arguments: [
            '[--public-base-url <url>] [--listen-host <host>] [--listen-port <port>]',
            '[--max-bytes <bytes>] [--json]',
          ],
          parse: Parsing.parseDocumentConfigSet,
        },
      ],
    },
  ],
}
