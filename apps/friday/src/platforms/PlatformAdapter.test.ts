import { assert, it } from '@effect/vitest'
import { ConversationBinding, InputMessage } from '@friday/contracts/conversation'
import * as Schema from 'effect/Schema'

import { platformHistorySource, type PlatformInput } from './PlatformAdapter.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeMessage = Schema.decodeSync(InputMessage)

const baseInput = (): Omit<PlatformInput, 'historySource' | 'discordHistorySource'> => ({
  binding: decodeBinding({
    platform: 'slack',
    connectionId: 'slack-conn',
    channelId: 'slack:T123:C456',
    sourceMessageId: '1234567890.111111',
    conversationId: 'slack:T123:C456',
  }),
  message: decodeMessage({
    source: 'user',
    author: {
      platformUserId: 'U111',
      mention: '<@U111>',
      username: null,
      displayName: null,
    },
    content: { text: 'hello', images: [] },
    platformMessageId: '1234567890.111111',
  }),
})

it('prefers historySource over the deprecated Discord alias', () => {
  const input: PlatformInput = {
    ...baseInput(),
    historySource: 'thread',
    discordHistorySource: 'channel',
  }
  assert.strictEqual(platformHistorySource(input), 'thread')
})

it('falls back to the Discord alias when historySource is absent', () => {
  const input: PlatformInput = { ...baseInput(), discordHistorySource: 'thread' }
  assert.strictEqual(platformHistorySource(input), 'thread')
})

it('reports no history source when neither field is set', () => {
  assert.strictEqual(platformHistorySource(baseInput()), undefined)
})
