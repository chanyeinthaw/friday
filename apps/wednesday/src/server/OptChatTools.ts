import { Effect, Schema } from 'effect'
import { defineTool } from '@humanlayer/fold-core'
import { WednesdayError } from './errors.ts'

/** Chat and memory use identical declarations so their static prefixes can share a cache. */
export const optChatTools = (memory: {
  readonly zoom: (id: number, count: number) => Effect.Effect<string, WednesdayError>
  readonly date: (id: number) => Effect.Effect<string, WednesdayError>
}) => [
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
