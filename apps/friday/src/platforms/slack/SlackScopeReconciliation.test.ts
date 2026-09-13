import { assert, it } from '@effect/vitest'

import {
  decodeSlackAdapterThreadId,
  decodeSlackConversationId,
  reconcileSlackLocation,
  toSlackAdapterChannelId,
  toSlackAdapterThreadId,
} from './SlackConversationScope.ts'

it('decodes adapter thread ids without a team', () => {
  assert.deepStrictEqual(decodeSlackAdapterThreadId('slack:C456'), { channelId: 'C456' })
  assert.deepStrictEqual(decodeSlackAdapterThreadId('slack:C456:'), { channelId: 'C456' })
  assert.deepStrictEqual(decodeSlackAdapterThreadId('slack:C456:1234567890.111111'), {
    channelId: 'C456',
    threadTs: '1234567890.111111',
  })
  assert.strictEqual(decodeSlackAdapterThreadId('slack:T123:C456'), undefined)
  assert.strictEqual(decodeSlackAdapterThreadId('discord:guild:channel'), undefined)
  assert.strictEqual(decodeSlackAdapterThreadId('discord:C456:1234567890.111111'), undefined)
  assert.strictEqual(decodeSlackAdapterThreadId('slack:C456:thread:extra'), undefined)
  // A channel id merely containing a C/D/G letter is still a foreign shape.
  assert.strictEqual(decodeSlackAdapterThreadId('slack:XC456'), undefined)
})

it('encodes canonical locations as team-less adapter ids', () => {
  assert.strictEqual(toSlackAdapterThreadId({ teamId: 'T123', channelId: 'C456' }), 'slack:C456:')
  assert.strictEqual(
    toSlackAdapterThreadId({ teamId: 'T123', channelId: 'C456', threadTs: '1234567890.111111' }),
    'slack:C456:1234567890.111111',
  )
  assert.strictEqual(toSlackAdapterChannelId({ channelId: 'C456' }), 'slack:C456')
  assert.strictEqual(
    toSlackAdapterThreadId({ teamId: 'T123', channelId: 'C456', threadTs: '   ' }),
    'slack:C456:',
  )
})

it('collapses top-level adapter threads to the shared channel root', () => {
  // reply-in-channel: the platform channel is the agent thread, so the
  // adapter per-message thread (`thread_ts ?? ts`) must not become persistence.
  const location = reconcileSlackLocation({ teamId: 'T123', channelId: 'C456' })
  assert.deepStrictEqual(location, { teamId: 'T123', channelId: 'C456' })
  assert.strictEqual(decodeSlackConversationId('slack:T123:C456')?.threadTs, undefined)
})

it('keeps threaded adapter messages on the platform thread', () => {
  // reply-in-thread: the platform thread is the agent thread.
  const location = reconcileSlackLocation({
    teamId: 'T123',
    channelId: 'C456',
    threadTs: '1234567890.111111',
  })
  assert.deepStrictEqual(location, {
    teamId: 'T123',
    channelId: 'C456',
    threadTs: '1234567890.111111',
  })
})

it('reconciles DMs and routed threads the same way', () => {
  const dmRoot = reconcileSlackLocation({ teamId: 'T123', channelId: 'D789' })
  assert.deepStrictEqual(dmRoot, { teamId: 'T123', channelId: 'D789' })
  const routed = reconcileSlackLocation({
    teamId: 'T123',
    channelId: 'C456',
    threadTs: '1234567890.111111',
  })
  assert.deepStrictEqual(routed.threadTs, '1234567890.111111')
})

it('treats blank thread timestamps as channel roots', () => {
  assert.deepStrictEqual(
    reconcileSlackLocation({ teamId: 'T123', channelId: 'C456', threadTs: '' }),
    { teamId: 'T123', channelId: 'C456' },
  )
  assert.deepStrictEqual(
    reconcileSlackLocation({ teamId: 'T123', channelId: 'C456', threadTs: '   ' }),
    { teamId: 'T123', channelId: 'C456' },
  )
})
