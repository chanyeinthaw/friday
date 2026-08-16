import * as Schema from 'effect/Schema'

const ModelIdentifier = Schema.String.pipe(Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()))

export const ProviderId = ModelIdentifier.pipe(Schema.brand('ProviderId'))
export type ProviderId = typeof ProviderId.Type

export const ModelId = ModelIdentifier.pipe(Schema.brand('ModelId'))
export type ModelId = typeof ModelId.Type

export const ThinkingLevel = Schema.Literals([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])
export type ThinkingLevel = typeof ThinkingLevel.Type

export const ModelSelection = Schema.Struct({
  provider: ProviderId,
  modelId: ModelId,
})
export type ModelSelection = typeof ModelSelection.Type
