import * as Schema from 'effect/Schema'

const HarnessIdentifier = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

// These serialized field names remain compatible with Friday's existing records.
// Agent execution is exclusively owned by pi-durable.
export const HarnessId = Schema.Literal('pi-durable').pipe(Schema.brand('HarnessId'))
export type HarnessId = typeof HarnessId.Type

export const HarnessSessionId = HarnessIdentifier.pipe(Schema.brand('HarnessSessionId'))
export type HarnessSessionId = typeof HarnessSessionId.Type

export const HarnessSession = Schema.Struct({
  id: HarnessSessionId,
  resumeCursor: Schema.Json,
})
export type HarnessSession = typeof HarnessSession.Type

export const HarnessTurnId = HarnessIdentifier.pipe(Schema.brand('HarnessTurnId'))
export type HarnessTurnId = typeof HarnessTurnId.Type
