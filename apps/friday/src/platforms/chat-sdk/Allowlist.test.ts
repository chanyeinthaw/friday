import { assert, it } from '@effect/vitest'

import { isAllowedByIds } from './Allowlist.ts'

it('allows every identifier when an allowlist is empty', () => {
  assert.strictEqual(
    isAllowedByIds({
      userId: 'user-1',
      channelId: 'channel-1',
      allowlist: { userIds: [], channelIds: [] },
    }),
    true,
  )
})

it('requires both configured user and channel identifiers', () => {
  const allowlist = { userIds: ['user-1'], channelIds: ['channel-1'] }
  assert.strictEqual(isAllowedByIds({ userId: 'user-1', channelId: 'channel-1', allowlist }), true)
  assert.strictEqual(isAllowedByIds({ userId: 'user-2', channelId: 'channel-1', allowlist }), false)
  assert.strictEqual(isAllowedByIds({ userId: 'user-1', channelId: 'channel-2', allowlist }), false)
})
