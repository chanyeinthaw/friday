import { assert, it } from '@effect/vitest'

import { FridaySlackAdapter } from './FridaySlackAdapter.ts'
import { makeMessageDedup } from './SlackLive.ts'
import { shouldInvokeSlack } from './SlackChannelAccess.ts'

it('fixes the Agent/AI experience over Socket Mode', () => {
  const adapter = new FridaySlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    resolveChannelPolicy: () => undefined,
  })
  assert.strictEqual(adapter.isSocketMode, true)
  // agentView keeps Agent Sessions events available; Friday only logs stopped
  // events and never drives working status or cancellation from them.
  assert.strictEqual(adapter.supportsTurnCancellation, true)
})

it('drops duplicate socket redeliveries of the same platform message', () => {
  const seen = makeMessageDedup(2)
  assert.strictEqual(seen.hasOrAdd('T123:C456:1234567890.111111'), false)
  assert.strictEqual(seen.hasOrAdd('T123:C456:1234567890.111111'), true)
  assert.strictEqual(seen.hasOrAdd('T123:C456:1234567890.222222'), false)
  // Bounded FIFO eviction keeps memory fixed; oldest keys become new again.
  assert.strictEqual(seen.hasOrAdd('T123:C456:1234567890.333333'), false)
  assert.strictEqual(seen.hasOrAdd('T123:C456:1234567890.111111'), false)
})

it('continues bound threads and DMs without a new mention', () => {
  assert.strictEqual(
    shouldInvokeSlack({ isDirectMessage: false, hasBinding: true, isDirectMention: false }),
    true,
  )
  assert.strictEqual(
    shouldInvokeSlack({ isDirectMessage: true, hasBinding: false, isDirectMention: false }),
    true,
  )
  assert.strictEqual(
    shouldInvokeSlack({ isDirectMessage: false, hasBinding: false, isDirectMention: false }),
    false,
  )
})
