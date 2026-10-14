import { Schema } from 'effect'

export const ToolActivity = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  input: Schema.String,
  status: Schema.Literals(['running', 'completed', 'failed', 'stopped']),
  output: Schema.optionalKey(Schema.String),
})
export interface ToolActivity extends Schema.Schema.Type<typeof ToolActivity> {}
export const ResponsePhase = Schema.Literals(['thinking', 'responding'])
