import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export const PiCatalogModel = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  name: Schema.String,
  api: Schema.String,
  reasoning: Schema.Boolean,
  input: Schema.Array(Schema.Literals(['text', 'image'])),
  contextWindow: Schema.Number,
  maxTokens: Schema.Number,
  available: Schema.Boolean,
})
export type PiCatalogModel = typeof PiCatalogModel.Type

export class PiModelCatalogError extends Schema.Error<PiModelCatalogError>('PiModelCatalogError')({
  _tag: Schema.tag('PiModelCatalogError'),
  operation: Schema.Literals(['load', 'reload']),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi model catalog ${this.operation} failed: ${this.detail}`
  }
}

const createRuntime = (operation: 'load' | 'reload') =>
  Effect.tryPromise({
    try: () => ModelRuntime.create({ allowModelNetwork: false }),
    catch: (cause) =>
      new PiModelCatalogError({
        operation,
        detail: 'Could not read Pi catalog and authentication state.',
        cause,
      }),
  })

const snapshot = (runtime: ModelRuntime): ReadonlyArray<PiCatalogModel> => {
  const available = new Set(
    runtime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
  )
  return runtime
    .getModels()
    .map((model) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
      api: model.api,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      available: available.has(`${model.provider}\0${model.id}`),
    }))
    .toSorted(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.modelId.localeCompare(right.modelId),
    )
}

/** Reads Pi-owned catalog and auth metadata. Secret values and request headers are never returned. */
export const listPiModels = Effect.fn('listPiModels')(function* (options?: {
  readonly provider?: string
  readonly availableOnly?: boolean
}) {
  const runtime = yield* createRuntime('load')
  return snapshot(runtime).filter(
    (model) =>
      (options?.provider === undefined || model.provider === options.provider) &&
      (options?.availableOnly !== true || model.available),
  )
})

export const getPiModel = Effect.fn('getPiModel')(function* (provider: string, modelId: string) {
  const models = yield* listPiModels({ provider })
  return models.find((model) => model.modelId === modelId)
})

/** Reloads models.json, the local model store, and auth metadata without network access. */
export const reloadPiModels = Effect.fn('reloadPiModels')(function* () {
  const runtime = yield* createRuntime('reload')
  const result = yield* Effect.tryPromise({
    try: () => runtime.refresh({ allowNetwork: false }),
    catch: (cause) =>
      new PiModelCatalogError({ operation: 'reload', detail: 'Local refresh failed.', cause }),
  })
  if (result.errors.size > 0) {
    return yield* new PiModelCatalogError({
      operation: 'reload',
      detail: [...result.errors.entries()]
        .map(([provider, cause]) => `${provider}: ${cause.message}`)
        .join('; '),
    })
  }
  return snapshot(runtime).length
})
