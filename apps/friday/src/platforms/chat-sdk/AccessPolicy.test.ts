import { assert, describe, it } from '@effect/vitest'

import { isAllowedByAccess, isAllowedByPolicy } from './AccessPolicy.ts'

const policies = {
  all: { mode: 'all', ids: [] },
  allow: { mode: 'allow', ids: ['known'] },
  deny: { mode: 'deny', ids: ['blocked'] },
} as const

describe('access policy', () => {
  it('allows every identifier in all mode', () => {
    assert.strictEqual(isAllowedByPolicy('anything', policies.all), true)
  })

  it('allows only listed identifiers in allow mode', () => {
    assert.strictEqual(isAllowedByPolicy('known', policies.allow), true)
    assert.strictEqual(isAllowedByPolicy('other', policies.allow), false)
  })

  it('denies only listed identifiers in deny mode', () => {
    assert.strictEqual(isAllowedByPolicy('blocked', policies.deny), false)
    assert.strictEqual(isAllowedByPolicy('other', policies.deny), true)
  })

  it('requires both user and channel policies to allow the message', () => {
    assert.strictEqual(
      isAllowedByAccess({
        userId: 'known',
        channelId: 'channel',
        userPolicy: policies.allow,
        channelPolicy: policies.all,
      }),
      true,
    )
    assert.strictEqual(
      isAllowedByAccess({
        userId: 'other',
        channelId: 'channel',
        userPolicy: policies.allow,
        channelPolicy: policies.all,
      }),
      false,
    )
  })
})
