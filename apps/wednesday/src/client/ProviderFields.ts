import { Effect, Schema } from 'effect'

export const FieldKind = Schema.Literals(['text', 'number', 'boolean', 'group', 'list', 'empty'])
export const ProviderField = Schema.Struct({
  id: Schema.Int,
  parentId: Schema.NullOr(Schema.Int),
  name: Schema.String,
  kind: FieldKind,
  value: Schema.String,
})
export type ProviderField = typeof ProviderField.Type

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json))
const isNumber = Schema.is(Schema.Number)
const isBoolean = Schema.is(Schema.Boolean)

export const editableFields = (
  fields: Readonly<Record<string, Schema.Json>>,
): readonly ProviderField[] => {
  const rows: ProviderField[] = []
  const visit = (name: string, value: Schema.Json, parentId: number | null) => {
    const id = rows.length
    const kind =
      value === null
        ? 'empty'
        : Array.isArray(value)
          ? 'list'
          : isObject(value)
            ? 'group'
            : isNumber(value)
              ? 'number'
              : isBoolean(value)
                ? 'boolean'
                : 'text'
    rows.push({
      id,
      parentId,
      name,
      kind,
      value: value === null || Array.isArray(value) || isObject(value) ? '' : String(value),
    })
    if (value !== null && (Array.isArray(value) || isObject(value))) {
      for (const [key, child] of Object.entries(value)) visit(key, child, id)
    }
  }
  for (const [name, value] of Object.entries(fields)) visit(name, value, null)
  return rows
}

// Turn the form's groups and values back into provider request fields.
export const requestFields = (rows: readonly ProviderField[]) => {
  const object = (parentId: number | null): Effect.Effect<Record<string, Schema.Json>, Error> =>
    Effect.gen(function* () {
      const children = rows.filter((row) => row.parentId === parentId)
      if (children.some((row) => !row.name.trim()))
        return yield* Effect.fail(new Error('Give every setting a name.'))
      if (new Set(children.map((row) => row.name.trim())).size !== children.length)
        return yield* Effect.fail(new Error('Setting names must be unique within each group.'))
      const entries = yield* Effect.forEach(children, (row) =>
        value(row).pipe(Effect.map((value) => [row.name.trim(), value] as const)),
      )
      return Object.fromEntries(entries)
    })
  const value = (row: ProviderField): Effect.Effect<Schema.Json, Error> =>
    Effect.gen(function* () {
      switch (row.kind) {
        case 'text':
          return row.value
        case 'boolean':
          return row.value === 'true'
        case 'empty':
          return null
        case 'number': {
          const number = Number(row.value)
          if (!row.value.trim() || !Number.isFinite(number))
            return yield* Effect.fail(
              new Error(`Enter a valid number for ${row.name || 'this setting'}.`),
            )
          return number
        }
        case 'group':
          return yield* object(row.id)
        case 'list':
          return yield* Effect.forEach(
            rows.filter((child) => child.parentId === row.id),
            value,
          )
      }
    })
  return object(null)
}

export const removeField = (
  rows: readonly ProviderField[],
  id: number,
): readonly ProviderField[] => {
  const removed = new Set([id])
  let previous = 0
  while (previous !== removed.size) {
    previous = removed.size
    for (const row of rows)
      if (row.parentId !== null && removed.has(row.parentId)) removed.add(row.id)
  }
  return rows.filter((row) => !removed.has(row.id))
}
