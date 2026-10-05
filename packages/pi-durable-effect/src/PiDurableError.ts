import * as Schema from 'effect/Schema'

export class PiDurableError extends Schema.Error<PiDurableError>('PiDurableError')({
  _tag: Schema.tag('PiDurableError'),
  detail: Schema.optionalKey(Schema.String),
  operation: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
