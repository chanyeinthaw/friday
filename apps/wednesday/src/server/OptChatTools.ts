import { webSearchDescription } from './Firecrawl.ts'
import { Effect, Schema } from 'effect'
import { defineTool } from '@humanlayer/fold-core'
import { WednesdayError } from './errors.ts'

/** Memory tools are shared; only chat sessions receive the attachment workspace. */
export const optChatTools = (
  memory: {
    readonly zoom: (id: number, count: number) => Effect.Effect<string, WednesdayError>
    readonly date: (id: number) => Effect.Effect<string, WednesdayError>
  },
  bash?: (command: string) => Effect.Effect<string, WednesdayError>,
  webSearch?: (query: string) => Effect.Effect<string, WednesdayError>,
) => [
  ...(webSearch
    ? [
        defineTool({
          name: 'web_search',
          description: webSearchDescription,
          parameters: Schema.Struct({ query: Schema.String }),
          success: Schema.String,
          failure: WednesdayError,
          handler: ({ query }) => webSearch(query),
        }),
      ]
    : []),
  ...(bash
    ? [
        defineTool({
          name: 'bash',
          description:
            'Run shell commands in a private virtual filesystem. /attachments is read-only; /tmp is writable for this turn. No network or host access.',
          parameters: Schema.Struct({ command: Schema.String }),
          success: Schema.String,
          failure: WednesdayError,
          handler: ({ command }) => bash(command),
        }),
      ]
    : []),
  defineTool({
    name: 'zoom',
    description:
      'Open an aligned summary range into its children, or retrieve one original message.',
    parameters: Schema.Struct({ id: Schema.Int, n: Schema.Int }),
    success: Schema.String,
    failure: WednesdayError,
    handler: ({ id, n }) => memory.zoom(id, n),
  }),
  defineTool({
    name: 'date',
    description: 'Return the timestamp of an original message.',
    parameters: Schema.Struct({ id: Schema.Int }),
    success: Schema.String,
    failure: WednesdayError,
    handler: ({ id }) => memory.date(id),
  }),
]
