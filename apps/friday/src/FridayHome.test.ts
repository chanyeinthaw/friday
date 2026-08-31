import { assert, it } from '@effect/vitest'

import { isPackagedEntryFileName } from './FridayHome.ts'

it('treats Bun virtual filesystem entry points as packaged builds', () => {
  assert.isTrue(isPackagedEntryFileName('/$bunfs/root/main'))
})

it('treats real source files as development builds', () => {
  assert.isFalse(isPackagedEntryFileName('/repo/apps/friday/src/main.ts'))
})

it('treats a missing entry file name as a development build', () => {
  assert.isFalse(isPackagedEntryFileName(undefined))
})
