import { ConversationBinding } from '@friday/contracts/conversation'
import { assert, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'

import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import {
  formatDiscordWorkingStatus,
  makeWorkingMessageLifecycle,
  splitMessage,
  type WorkingMessageTransport,
} from './WorkingMessageLifecycle.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const binding = decodeBinding({
  platform: 'test',
  connectionId: 'test',
  channelId: 'channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'conversation-1',
})

interface TestHandle {
  readonly id: string
}

const makeFake = (chunkLimit = 10) => {
  const events: Array<string> = []
  const messages: Array<string> = []
  let counter = 0
  interface FakeControls {
    failPost: unknown
    failEdit: unknown
    failDelete: unknown
    failLatest: unknown
  }
  const controls: FakeControls = {
    failPost: undefined,
    failEdit: undefined,
    failDelete: undefined,
    failLatest: undefined,
  }
  const transport: WorkingMessageTransport<TestHandle, ChatSdkPublicationError> = {
    chunksFor: (text) => splitMessage(text, chunkLimit),
    post: async (_binding, text) => {
      if (controls.failPost !== undefined) throw controls.failPost
      counter += 1
      const id = `msg-${counter}`
      messages.push(id)
      events.push(`post:${id}:${text}`)
      return { id }
    },
    edit: async (handle, _binding, text) => {
      if (controls.failEdit !== undefined) throw controls.failEdit
      events.push(`edit:${handle.id}:${text}`)
      return handle
    },
    delete: async (handle) => {
      if (controls.failDelete !== undefined) throw controls.failDelete
      events.push(`delete:${handle.id}`)
      const index = messages.indexOf(handle.id)
      if (index >= 0) messages.splice(index, 1)
    },
    latestId: async () => {
      if (controls.failLatest !== undefined) throw controls.failLatest
      return messages.at(-1)
    },
    idOf: (handle) => handle.id,
    mapError: (operation, cause) => new ChatSdkPublicationError({ operation, cause }),
  }
  const overtakenBy = (id: string): void => {
    messages.push(id)
  }
  return { transport, events, messages, controls, overtakenBy }
}

it.effect('edits the tracked message when it remains latest', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    yield* lifecycle.update({ binding, text: 'Reading...' })
    yield* lifecycle.finalize({ binding, text: 'Done.' })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking...',
      'edit:msg-1:Reading...',
      'edit:msg-1:Done.',
    ])
  }),
)

it.effect('formats begin and update for display while finalize stays plain', () =>
  Effect.gen(function* () {
    const fake = makeFake(50)
    const lifecycle = makeWorkingMessageLifecycle({
      ...fake.transport,
      formatWorking: formatDiscordWorkingStatus,
    })

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    yield* lifecycle.update({ binding, text: 'Reading files...' })
    yield* lifecycle.finalize({ binding, text: 'Final answer.' })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:-# Thinking...',
      'edit:msg-1:-# Reading files...',
      'edit:msg-1:Final answer.',
    ])
  }),
)

it.effect('deletes an overtaken message and reposts fresh at the bottom', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    fake.overtakenBy('user-1')
    yield* lifecycle.finalize({ binding, text: 'Done.' })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking...',
      'delete:msg-1',
      'post:msg-2:Done.',
    ])
  }),
)

it.effect('keeps long chunk ordering on the latest path', () =>
  Effect.gen(function* () {
    const fake = makeFake(10)
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)
    const text = '1234567890abcdefghijXYZ'

    yield* lifecycle.begin({ binding, text: 'Thinking' })
    yield* lifecycle.finalize({ binding, text })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking',
      'edit:msg-1:1234567890',
      'post:msg-2:abcdefghij',
      'post:msg-3:XYZ',
    ])
  }),
)

it.effect('keeps long chunk ordering on the overtaken path', () =>
  Effect.gen(function* () {
    const fake = makeFake(10)
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)
    const text = '1234567890abcdefghijXYZ'

    yield* lifecycle.begin({ binding, text: 'Thinking' })
    fake.overtakenBy('user-1')
    yield* lifecycle.finalize({ binding, text })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking',
      'delete:msg-1',
      'post:msg-2:1234567890',
      'post:msg-3:abcdefghij',
      'post:msg-4:XYZ',
    ])
  }),
)

it.effect('posts fresh when no message is tracked', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    yield* lifecycle.update({ binding, text: 'ignored' })
    yield* lifecycle.finalize({ binding, text: 'Fresh.' })

    assert.deepStrictEqual(fake.events, ['post:msg-1:Fresh.'])
  }),
)

it.effect('deletes the tracked message on empty finalize and discard', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    yield* lifecycle.finalize({ binding, text: '   ' })
    assert.deepStrictEqual(fake.events, ['post:msg-1:Thinking...', 'delete:msg-1'])

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    yield* lifecycle.discard(binding)
    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking...',
      'delete:msg-1',
      'post:msg-2:Thinking...',
      'delete:msg-2',
    ])
  }),
)

it.effect('ignores discard when nothing is tracked', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    yield* lifecycle.discard(binding)

    assert.deepStrictEqual(fake.events, [])
  }),
)

it.effect('still reposts when the overtaken delete fails', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    fake.controls.failDelete = new Error('already deleted')
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    fake.controls.failDelete = new Error('already deleted')
    fake.overtakenBy('user-1')
    yield* lifecycle.finalize({ binding, text: 'Done.' })

    assert.deepStrictEqual(fake.events, ['post:msg-1:Thinking...', 'post:msg-2:Done.'])
  }),
)

it.effect('propagates transport failures so callers keep their publish fallback', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    const isPublicationError = Schema.is(ChatSdkPublicationError)
    const operationOf = (exit: Exit.Exit<void, ChatSdkPublicationError>): string | undefined => {
      if (!Exit.isFailure(exit)) return undefined
      const error = Cause.squash(exit.cause)
      return isPublicationError(error) ? error.operation : undefined
    }

    fake.controls.failPost = new Error('post down')
    const beginExit = yield* lifecycle.begin({ binding, text: 'Thinking...' }).pipe(Effect.exit)
    assert.isTrue(Exit.isFailure(beginExit))
    assert.strictEqual(operationOf(beginExit), 'begin-working')
    fake.controls.failPost = undefined

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    fake.controls.failEdit = new Error('edit down')
    const updateExit = yield* lifecycle.update({ binding, text: 'Reading...' }).pipe(Effect.exit)
    assert.isTrue(Exit.isFailure(updateExit))
    assert.strictEqual(operationOf(updateExit), 'update-working')
    fake.controls.failEdit = undefined

    fake.controls.failLatest = new Error('fetch down')
    const finalizeExit = yield* lifecycle.finalize({ binding, text: 'Done.' }).pipe(Effect.exit)
    assert.isTrue(Exit.isFailure(finalizeExit))
    assert.strictEqual(operationOf(finalizeExit), 'finalize-working')
    fake.controls.failLatest = undefined

    // A failing chunk post during finalization keeps the finalize operation.
    fake.controls.failPost = new Error('chunk down')
    const chunkExit = yield* lifecycle
      .finalize({ binding, text: '1234567890abcdefghijXYZ' })
      .pipe(Effect.exit)
    assert.isTrue(Exit.isFailure(chunkExit))
    assert.strictEqual(operationOf(chunkExit), 'finalize-working')
    fake.controls.failPost = undefined

    // A failing edit during finalization keeps the finalize operation.
    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    fake.controls.failEdit = new Error('edit down')
    const finalizeEditExit = yield* lifecycle.finalize({ binding, text: 'Done.' }).pipe(Effect.exit)
    assert.isTrue(Exit.isFailure(finalizeEditExit))
    assert.strictEqual(operationOf(finalizeEditExit), 'finalize-working')
    fake.controls.failEdit = undefined

    // A failing chunk post after the latest-path edit keeps the operation.
    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    fake.controls.failPost = new Error('chunk down')
    const latestChunkExit = yield* lifecycle
      .finalize({ binding, text: '1234567890abcdefghijXYZ' })
      .pipe(Effect.exit)
    assert.isTrue(Exit.isFailure(latestChunkExit))
    assert.strictEqual(operationOf(latestChunkExit), 'finalize-working')
  }),
)

it.effect('tracks the refreshed handle returned by edits', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    let revisions = 0
    const base = fake.transport
    const lifecycle = makeWorkingMessageLifecycle({
      ...base,
      edit: async (handle, _editBinding, text) => {
        revisions += 1
        await base.edit({ id: `${handle.id}#${revisions}` }, binding, text)
        return { id: `${handle.id}#${revisions}` }
      },
    })

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    yield* lifecycle.update({ binding, text: 'Reading...' })
    yield* lifecycle.update({ binding, text: 'Searching...' })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking...',
      'edit:msg-1#1:Reading...',
      'edit:msg-1#1#2:Searching...',
    ])
  }),
)

it.effect('tracks working messages independently per conversation', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)
    const other = decodeBinding({
      platform: 'test',
      connectionId: 'test',
      channelId: 'channel-2',
      sourceMessageId: 'message-2',
      conversationId: 'conversation-2',
    })

    yield* lifecycle.begin({ binding, text: 'Thinking one...' })
    yield* lifecycle.begin({ binding: other, text: 'Thinking two...' })
    yield* lifecycle.update({ binding, text: 'Reading one...' })
    yield* lifecycle.finalize({ binding: other, text: 'Done two.' })
    // The first conversation no longer owns the latest visible message, so
    // overtaken awareness reposts it fresh instead of editing above.
    yield* lifecycle.finalize({ binding, text: 'Done one.' })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking one...',
      'post:msg-2:Thinking two...',
      'edit:msg-1:Reading one...',
      'edit:msg-2:Done two.',
      'delete:msg-1',
      'post:msg-3:Done one.',
    ])
  }),
)

it.effect('posts fresh on the finalize after a finalize', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    yield* lifecycle.finalize({ binding, text: 'Done.' })
    yield* lifecycle.finalize({ binding, text: 'Again.' })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking...',
      'edit:msg-1:Done.',
      'post:msg-2:Again.',
    ])
  }),
)

it.effect('deletes on empty finalize and posts fresh when untracked', () =>
  Effect.gen(function* () {
    const fake = makeFake()
    const lifecycle = makeWorkingMessageLifecycle(fake.transport)

    yield* lifecycle.begin({ binding, text: 'Thinking...' })
    yield* lifecycle.finalize({ binding, text: '   ' })
    yield* lifecycle.finalize({ binding, text: 'Fresh.' })

    assert.deepStrictEqual(fake.events, [
      'post:msg-1:Thinking...',
      'delete:msg-1',
      'post:msg-2:Fresh.',
    ])
  }),
)

it('splits at paragraph and word boundaries', () => {
  const text = `${'a'.repeat(12)}\n\n${'b'.repeat(12)} ${'c'.repeat(12)}`
  // A paragraph break past the soft-break minimum wins over later word breaks.
  assert.deepStrictEqual(splitMessage(text, 20), [
    `${'a'.repeat(12)}\n\n`,
    `${'b'.repeat(12)} `,
    'c'.repeat(12),
  ])

  // A paragraph break at the soft-break minimum wins over a later line break.
  const later = `${'a'.repeat(10)}\n\n${'b'.repeat(4)}\n${'c'.repeat(12)}`
  assert.deepStrictEqual(splitMessage(later, 20), [
    `${'a'.repeat(10)}\n\n`,
    `${'b'.repeat(4)}\n${'c'.repeat(12)}`,
  ])

  // A word break exactly at the soft-break minimum still splits there.
  const words = `${'a'.repeat(5)} ${'b'.repeat(14)}`
  assert.deepStrictEqual(splitMessage(words, 10), [`${'a'.repeat(5)} `, 'b'.repeat(10), 'bbbb'])
})

it('keeps mismatched and trailing-text fences from closing a code block', () => {
  const mismatched = `Before\n\n\`\`\`js\n${'const value = 1;\n'.repeat(3)}~~~\n\nAfter`
  const chunks = splitMessage(mismatched, 40)
  // The tilde line never closes the backtick fence: every chunk stays fenced
  // and the tilde line survives as content inside the final chunk.
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.includes('```js')))
  assert.ok(chunks[chunks.length - 1]?.includes('~~~\n\nAfter'))

  // A mismatched fence mid-block never closes it: later chunks keep reopening.
  const reopened = splitMessage(
    `\`\`\`js\n${'const value = 1;\n'.repeat(2)}~~~\n${'const value = 2;\n'.repeat(2)}\`\`\`\nAfter`,
    40,
  )
  assert.deepStrictEqual(reopened, [
    '```js\nconst value = 1;\n```',
    '```js\nconst value = 1;\n~~~\n```',
    '```js\nconst value = 2;\n```',
    '```js\nconst value = 2;\n```\nAfter',
  ])

  // A closing fence with trailing text never closes the block either.
  const trailing = splitMessage('```\n0123456789abcdef0123456789\n``` trailing\nend', 30)
  assert.ok(trailing.length > 1)
  assert.ok(trailing.every((chunk) => chunk.startsWith('```')))
  assert.ok(trailing.some((chunk) => chunk.includes('``` trailing')))
  // The fence stays open through the end, so open chunks keep their suffix.
  assert.ok(
    trailing
      .filter((chunk) => chunk.includes('``` trailing'))
      .every((chunk) => chunk.endsWith('\n```')),
  )

  // A closing fence with only trailing whitespace still closes the block.
  const spaced = splitMessage('```\n0123456789abcdef0123456789\n``` \nend', 30)
  assert.ok(spaced.length > 1)
  assert.ok(spaced[0]?.endsWith('\n```'))
  assert.strictEqual(spaced[spaced.length - 1], '```\n6789\n``` \nend')
})

it('keeps a longer fence open past a shorter lookalike close', () => {
  const text = `\`\`\`js\n${'x'.repeat(50)}\n~~~~\n${'y'.repeat(50)}`
  assert.deepStrictEqual(splitMessage(text, 40), [
    '```js\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n```',
    '```js\nxxxxxxxxxxxxxxxxxxxx\n~~~~\n```',
    '```js\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\n```',
    '```js\nyyyyyyyyyyyyyyyyyyyy\n```',
  ])
})

it('keeps a four-backtick fence open past a three-backtick line', () => {
  const text = `\`\`\`\`\n${'z'.repeat(60)}\n\`\`\``
  assert.deepStrictEqual(splitMessage(text, 40), [
    '````\nzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n````',
    '````\nzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n````',
    '````\n\n```\n````',
  ])
})

it('treats mid-line fences as plain text', () => {
  const text = `value with \`\`\` inline\nnext line here`
  const chunks = splitMessage(text, 40)
  assert.ok(chunks.every((chunk) => !chunk.startsWith('```')))

  const long = `value with \`\`\` inline ${'and more text '.repeat(6)}end`
  const longChunks = splitMessage(long, 40)
  assert.ok(longChunks.length > 1)
  assert.ok(longChunks.every((chunk) => !chunk.startsWith('```')))
  assert.strictEqual(longChunks.join(''), long)
})

it('splits long fenced runs within the limit with newline-separated closes', () => {
  const text = `~~~text\n${'v'.repeat(50)}\n~~~`
  assert.deepStrictEqual(splitMessage(text, 30), [
    '~~~text\nvvvvvvvvvvvvvvvvvv\n~~~',
    '~~~text\nvvvvvvvvvvvvvvvvvv\n~~~',
    '~~~text\nvvvvvvvvvvvvvv\n~~~',
  ])
})

it('never splits inside a fenced block without closing and reopening it', () => {
  const text = `~~~text\n${'value line\n'.repeat(6)}~~~`
  const chunks = splitMessage(text, 30)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.length <= 30))
  assert.ok(chunks.every((chunk) => chunk.startsWith('~~~text') && chunk.endsWith('~~~')))
  // Continued chunks close the fence on its own line.
  assert.ok(chunks.slice(0, -1).every((chunk) => chunk.endsWith('\n~~~')))
})

it('terminates on pathological fence declarations', () => {
  const text = '```averylonglanguagenamethatexceedsthelimit\nbody text here'
  const chunks = splitMessage(text, 10)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.includes('```')))
})

it('adjusts the split only for real surrogate pairs at the boundary', () => {
  // A high surrogate followed by a non-low character is not a pair.
  const highThenPlain = `${'a'.repeat(9)}\uD83Dbcdefgh`
  assert.deepStrictEqual(splitMessage(highThenPlain, 10), [`${'a'.repeat(9)}\uD83D`, 'bcdefgh'])

  // A character just below the high-surrogate range never pairs either.
  const belowRange = `${'a'.repeat(9)}\uD7FF\uDE00bcdefgh`
  assert.deepStrictEqual(splitMessage(belowRange, 10), [`${'a'.repeat(9)}\uD7FF`, '\uDE00bcdefgh'])

  // Exact range edges still count as pairs and stay together.
  for (const pair of ['\uD800\uDC00', '\uDBFF\uDFFF', '\uD83D\uDC00', '\uD83D\uDFFF']) {
    assert.deepStrictEqual(splitMessage(`${'a'.repeat(9)}${pair}b`, 10), [
      'a'.repeat(9),
      `${pair}b`,
    ])
  }

  // A lone low surrogate never pairs, even followed by a low surrogate.
  const lowThenLow = `${'a'.repeat(9)}\uDC00\uDE00bcdefg`
  assert.deepStrictEqual(splitMessage(lowThenLow, 10), [`${'a'.repeat(9)}\uDC00`, '\uDE00bcdefg'])

  // A high surrogate followed by a non-surrogate never pairs either.
  const highThenBmp = `${'a'.repeat(9)}\uD83D\uE000bcdefg`
  assert.deepStrictEqual(splitMessage(highThenBmp, 10), [`${'a'.repeat(9)}\uD83D`, '\uE000bcdefg'])
})
