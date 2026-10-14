import { Schema } from 'effect'
import type { ToolActivity } from '../shared/Activity.ts'

export const ToolArguments = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  query: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.Number),
  n: Schema.optionalKey(Schema.Number),
})
export const decodeToolArguments = Schema.decodeUnknownOption(ToolArguments)
export const emptyToolArguments: typeof ToolArguments.Type = {}
/** Keep the UI readable without exposing argument JSON or internal memory addressing. */
export const toolActivity = (
  id: string,
  name: string,
  args: typeof ToolArguments.Type,
): ToolActivity => {
  let input = ''
  if (name === 'bash') input = args.command?.slice(0, 2000) ?? ''
  else if (name === 'web_search') input = args.query?.slice(0, 500) ?? ''
  else if (args.id !== undefined) {
    const count = name === 'zoom' ? (args.n ?? 1) : 1
    input = count > 1 ? `Messages ${args.id + 1}–${args.id + count}` : `Message ${args.id + 1}`
  }
  return { id, name, input, status: 'running' }
}
