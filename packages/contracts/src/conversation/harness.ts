import * as Schema from 'effect/Schema'

const HarnessIdentifier = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

export const HarnessId = HarnessIdentifier.pipe(Schema.brand('HarnessId'))
export type HarnessId = typeof HarnessId.Type

export const HarnessSessionId = HarnessIdentifier.pipe(Schema.brand('HarnessSessionId'))
export type HarnessSessionId = typeof HarnessSessionId.Type

export const HarnessTurnId = HarnessIdentifier.pipe(Schema.brand('HarnessTurnId'))
export type HarnessTurnId = typeof HarnessTurnId.Type
