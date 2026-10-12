import { Schema } from 'effect'

export class WednesdayError extends Schema.Error<WednesdayError>('WednesdayError')({
  _tag: Schema.tag('WednesdayError'),
  message: Schema.String,
}) {}
export const failure = (message: string) => new WednesdayError({ message })
