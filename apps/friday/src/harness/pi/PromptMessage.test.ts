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
    'Participant:\np1 = user-1 | chan | Chan\n\np1 [trigger]: Hello Friday',
  )
})

it('indents multiline participant messages', () => {
  const message = decodeMessage({
    source: 'user',
    author: {
      platformUserId: 'user-1',
      username: null,
      displayName: 'Chan',
    },
    content: { text: 'Requirements:\n- inspect deployment\n- check config', images: [] },
  })

  assert.strictEqual(
    renderPromptMessage(message),
    'Participant:\np1 = user-1 | - | Chan\n\np1 [trigger]: Requirements:\n  - inspect deployment\n  - check config',
  )
})

it('leaves internal messages unchanged', () => {
  const message = decodeMessage({
    source: 'agent',
    content: { text: 'Background work completed.', images: [] },
  })

  assert.strictEqual(renderPromptMessage(message), 'Background work completed.')
})
