import * as Schema from 'effect/Schema'

/** Invalid model input that must be reported as a tool failure. */
export class PlatformToolError extends Schema.Error<PlatformToolError>('PlatformToolError')({
  _tag: Schema.tag('PlatformToolError'),
  message: Schema.String,
}) {}
