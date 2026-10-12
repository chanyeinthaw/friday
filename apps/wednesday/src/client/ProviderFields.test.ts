import { it } from '@effect/vitest'
import { expect } from 'vitest'
import { Effect } from 'effect'
import { editableFields, requestFields } from './ProviderFields.ts'

it.effect('editable settings preserve nested provider options and their value types', () =>
  Effect.gen(function* () {
    const settings = {
      reasoning: { effort: 'high', budget: 4096 },
      enabled: true,
      stop: ['end', 'done'],
      seed: null,
    }
    const rows = editableFields(settings)
    const budget = rows.find((row) => row.name === 'budget')
    const edited = rows.map((row) => (row.id === budget?.id ? { ...row, value: '8192' } : row))
    expect(yield* requestFields(edited)).toEqual({
      ...settings,
      reasoning: { effort: 'high', budget: 8192 },
    })
  }),
)

it.effect('invalid numeric input cannot silently become a provider value', () =>
  Effect.gen(function* () {
    const rows = editableFields({ temperature: 0.5 }).map((row) => ({
      ...row,
      value: 'not a number',
    }))
    const result = yield* requestFields(rows).pipe(Effect.result)
    expect(result._tag).toBe('Failure')
  }),
)
