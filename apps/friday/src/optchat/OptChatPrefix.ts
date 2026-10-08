import type { Tool } from '@earendil-works/pi-ai'
import * as Schema from 'effect/Schema'

const ToolDefinition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  constrainedSampling: Schema.optionalKey(
    Schema.Union([
      Schema.Literal(false),
      Schema.Struct({
        type: Schema.Literal('json_schema'),
        strict: Schema.Literals(['prefer', 'require']),
      }),
      Schema.Struct({
        type: Schema.Literal('grammar'),
        variants: Schema.Struct({
          openai_lark: Schema.optionalKey(Schema.String),
          openai_regex: Schema.optionalKey(Schema.String),
        }),
      }),
    ]),
  ),
})

/** The channel's exact instructions and ordered model-visible tool declarations. */
export interface OptChatPrefix {
  readonly systemPrompt: string
  readonly tools: readonly Tool[]
}

export const OptChatPrefix = Schema.Struct({
  systemPrompt: Schema.String,
  tools: Schema.Array(ToolDefinition),
})
export const prefixCodec = Schema.fromJsonString(OptChatPrefix)
