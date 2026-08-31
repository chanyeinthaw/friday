import { assert, it } from '@effect/vitest'

import { effectiveInvocationMode, shouldInvoke } from './InvocationPolicies.ts'

type Invocation = Parameters<typeof effectiveInvocationMode>[0]

const invocation = (overrides: Partial<Invocation> = {}): Invocation => ({
  defaultMode: 'mention-only',
  channels: [],
  ...overrides,
})

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

it('resolves the channel override before the connection default', () => {
  const policies = invocation({
    defaultMode: 'mention-only',
    channels: [{ channelId: 'loud', mode: 'all-messages' }],
  })
  assert.strictEqual(effectiveInvocationMode(policies, 'loud'), 'all-messages')
  assert.strictEqual(effectiveInvocationMode(policies, 'quiet'), 'mention-only')
})

it('falls back to the connection default when no channel override exists', () => {
  assert.strictEqual(
    effectiveInvocationMode(invocation({ defaultMode: 'all-messages' }), 'any'),
    'all-messages',
  )
})
