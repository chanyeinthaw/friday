import * as Schema from 'effect/Schema'

export const IsoDateTime = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u)),
)
export type IsoDateTime = typeof IsoDateTime.Type

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export type NonNegativeInt = typeof NonNegativeInt.Type

export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export type PositiveInt = typeof PositiveInt.Type
