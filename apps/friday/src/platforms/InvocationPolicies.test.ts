import { assert, it } from '@effect/vitest'

import { shouldInvoke } from './InvocationPolicies.ts'

it('invokes every accepted message in all-message mode', () => {
  assert.strictEqual(
    shouldInvoke({ kind: 'subscribed-message', mode: 'all-messages', hasBinding: false }),
    true,
  )
})

it('requires a mention to create a conversation in mention-only mode', () => {
  assert.strictEqual(
    shouldInvoke({ kind: 'subscribed-message', mode: 'mention-only', hasBinding: false }),
    false,
  )
  assert.strictEqual(
    shouldInvoke({ kind: 'mention', mode: 'mention-only', hasBinding: false }),
    true,
  )
})

it('keeps established mention-only conversations responsive without another mention', () => {
  assert.strictEqual(
    shouldInvoke({ kind: 'subscribed-message', mode: 'mention-only', hasBinding: true }),
    true,
  )
})

it('always accepts direct messages', () => {
  assert.strictEqual(
    shouldInvoke({ kind: 'direct-message', mode: 'mention-only', hasBinding: false }),
    true,
  )
})
