import { assert, it } from '@effect/vitest'
import { InputMessage } from '@friday/contracts/conversation'
import * as Schema from 'effect/Schema'

import { renderPromptMessage } from './PromptMessage.ts'

const decodeMessage = Schema.decodeSync(InputMessage)

it('attributes a channel participant in the Pi prompt', () => {
  const message = decodeMessage({
    source: 'user',
    author: {
      platformUserId: 'user-1',
      username: 'chan',
      displayName: 'Chan',
    },
    content: { text: 'Hello Friday', images: [] },
  })

  assert.strictEqual(
    renderPromptMessage(message),
    '<channel-participant>\nplatform-user-id: user-1\nusername: chan\ndisplay-name: Chan\n</channel-participant>\n\n<message>\nHello Friday\n</message>',
  )
})

it('leaves internal messages unchanged', () => {
  const message = decodeMessage({
    source: 'agent',
    content: { text: 'Background work completed.', images: [] },
  })

  assert.strictEqual(renderPromptMessage(message), 'Background work completed.')
})
