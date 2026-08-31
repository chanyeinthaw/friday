import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { TestClock } from 'effect/testing'
import { vi } from 'vitest'

import {
  ActivityLabelLimit,
  makeDiscordAgentActivity,
  packApplicationDescription,
  sanitizeTaskLabel,
} from './DiscordAgentActivity.ts'

const decodeDescriptionBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ description: Schema.String })),
)

const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'discord:channel-1',
})

// Guild-less decode keeps the legacy nickname path out of the description tests.
const discord = {
  decodeThreadId: (threadId: string) => ({
    guildId: '',
    channelId: threadId.split(':')[1] ?? '',
  }),
}

const makeDiscordFetch = () => {
  const patches: Array<string> = []
  const state = { failDescriptionPatch: false }
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/applications/@me')) {
      if (state.failDescriptionPatch) return new Response(null, { status: 500 })
      const body = decodeDescriptionBody(init?.body ?? '')
      patches.push(body.description)
      return new Response(null, { status: 200 })
    }
    if (url.includes('/channels/')) return Response.json({ name: 'general' })
    return new Response(null, { status: 404 })
  })
  return {
    fetchMock,
    patches,
    setFail: (fail: boolean) => void (state.failDescriptionPatch = fail),
  }
}

const withStubbedFetch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.ensuring(
    effect,
    Effect.sync(() => vi.unstubAllGlobals()),
  )

it('keeps complete lines and reports a singular hidden task', () => {
  const description = packApplicationDescription(
    [
      '[#general] Implement the packing tests',
      '[#deploy] Fix the release pipeline',
      '[#review] Review the adapter',
    ],
    100,
  )
  assert.strictEqual(
    description,
    '[#general] Implement the packing tests\n[#deploy] Fix the release pipeline\n... 1 more task.',
  )
})

it('uses the plural overflow text for multiple hidden tasks', () => {
  const description = packApplicationDescription(
    [
      '[#general] Implement the packing tests',
      '[#deploy] Fix the release pipeline',
      '[#review] Review the adapter',
    ],
    60,
  )
  assert.strictEqual(description, '[#general] Implement the packing tests\n... 2 more tasks.')
})

it('joins every line when the description fits the limit', () => {
  const lines = ['[#general] Task one', '[#deploy] Task two']
  assert.strictEqual(packApplicationDescription(lines, 400), lines.join('\n'))
})

it('drops complete lines until the overflow note fits instead of truncating mid-line', () => {
  const description = packApplicationDescription(['x'.repeat(385), 'ok'], 400)
  assert.strictEqual(description, '... 2 more tasks.')
})

it('counts code points rather than UTF-16 units against the limit', () => {
  const rocket = '🚀'.repeat(300)
  assert.strictEqual(packApplicationDescription([rocket], 400), rocket)
})

it('reflows the overflow count when a hidden task finishes', () => {
  const lines = ['[#a] One', '[#b] Two', '[#c] Three', '[#d] Four']
  const packed = packApplicationDescription(lines, 28)
  assert.strictEqual(packed, '[#a] One\n... 3 more tasks.')
  assert.strictEqual(
    packApplicationDescription(
      lines.filter((line) => line !== '[#d] Four'),
      28,
    ),
    '[#a] One\n... 2 more tasks.',
  )
})

it('derives a concise label from the first meaningful prompt line', () => {
  assert.strictEqual(
    sanitizeTaskLabel('```\ncode\n```\n<@123456789012345678> - Implement the feature\nmore detail'),
    'Implement the feature',
  )
  assert.strictEqual(sanitizeTaskLabel('   \n\t'), '')
})

it('caps labels with an ellipsis', () => {
  const label = sanitizeTaskLabel('x'.repeat(200))
  assert.strictEqual(label, `${'x'.repeat(ActivityLabelLimit - 1)}…`)
  assert.strictEqual(label.length, ActivityLabelLimit)
})

it.effect('coalesces task transitions into one debounced description patch', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = makeDiscordAgentActivity(discord, 'bot-token', {
        descriptionDebounce: '1 second',
      })

      yield* activity({
        binding,
        taskId: 'task-1',
        active: true,
        task: 'Implement the packing tests',
      })
      yield* activity({ binding, taskId: 'task-2', active: true, task: 'Review the adapter' })
      assert.deepStrictEqual(patches, [])
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [
        '[#general] Implement the packing tests\n[#general] Review the adapter',
      ])
      assert.strictEqual(
        fetchMock.mock.calls.filter(([url]) => url.endsWith('/applications/@me')).length,
        1,
      )

      yield* activity({ binding, taskId: 'task-1', active: false })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [
        '[#general] Implement the packing tests\n[#general] Review the adapter',
        '[#general] Review the adapter',
      ])

      // Finishing an unknown task changes nothing, so the unchanged output is skipped.
      yield* activity({ binding, taskId: 'task-3', active: false })
      yield* TestClock.adjust('1 second')
      assert.strictEqual(patches.length, 2)
    }),
  ),
)

it.effect('overflows with complete lines and an accurate hidden-task count', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = makeDiscordAgentActivity(discord, 'bot-token', {
        descriptionDebounce: '1 second',
      })

      for (const [index, active] of [true, true, true, true, true, true, true].entries()) {
        yield* activity({
          binding,
          taskId: `task-${index + 1}`,
          active,
          task: 'x'.repeat(200),
        })
      }
      yield* TestClock.adjust('1 second')

      const lines = patches[0]?.split('\n') ?? []
      assert.strictEqual(lines.length, 6)
      assert.strictEqual(lines[0], `[#general] ${'x'.repeat(63)}…`)
      assert.strictEqual(lines[4], `[#general] ${'x'.repeat(63)}…`)
      assert.strictEqual(lines[5], '... 2 more tasks.')
      assert.strictEqual(patches[0]?.length, 397)

      yield* activity({ binding, taskId: 'task-7', active: false })
      yield* TestClock.adjust('1 second')
      const reflowed = patches[1]?.split('\n') ?? []
      assert.strictEqual(reflowed[5], '... 1 more task.')
    }),
  ),
)

it.effect('keeps going when the description patch fails and retries on the next event', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches, setFail } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = makeDiscordAgentActivity(discord, 'bot-token', {
        descriptionDebounce: '1 second',
      })

      setFail(true)
      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Implement the feature' })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [])

      setFail(false)
      yield* activity({ binding, taskId: 'task-1', active: false })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [''])
    }),
  ),
)

it.effect('skips description updates when disabled by configuration', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: false,
        descriptionDebounce: '1 second',
      })

      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Implement the feature' })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [])
      assert.strictEqual(
        fetchMock.mock.calls.filter(([url]) => url.includes('/applications/@me')).length,
        0,
      )
    }),
  ),
)

it.effect('falls back to a placeholder when task text is missing', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = makeDiscordAgentActivity(discord, 'bot-token', {
        descriptionDebounce: '1 second',
      })

      yield* activity({ binding, taskId: 'task-1', active: true })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, ['[#general] Working...'])
    }),
  ),
)
