// /models has no standard price metadata; prefer recognisable lightweight variants when available.
export const defaultMemoryModelId = (models: readonly { id: string }[]): string =>
  models.find((model) => /luna-fast/.test(model.id))?.id ??
  models.find((model) => /haiku/.test(model.id))?.id ??
  models.find((model) => /(?:mini|flash)/.test(model.id))?.id ??
  ''
