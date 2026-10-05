import * as Cause from 'effect/Cause'
import * as Schema from 'effect/Schema'

export class PiDurableError extends Schema.Error<PiDurableError>('PiDurableError')({
  _tag: Schema.tag('PiDurableError'),
  detail: Schema.optionalKey(Schema.String),
  operation: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    if (this.detail !== undefined) return this.detail
    if (this.cause instanceof Error) return this.cause.message
    return this.cause === undefined ? this.operation : Cause.pretty(Cause.fail(this.cause))
  }
}
