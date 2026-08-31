import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { TestClock } from 'effect/testing'
import { vi } from 'vitest'

import {
  ActivityLabelLimit,
  findDuplicateDiscordApplications,
  hasOwnedDescription,
  makeDiscordAgentActivity,
  packApplicationDescription,
  retryAfterMilliseconds,
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

const makeDiscordFetch = (initialDescription = '', channelName = 'general') => {
  const patches: Array<string> = []
  const state = { failDescriptionPatch: false, description: initialDescription }
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.endsWith('/applications/@me')) {
      if (init?.body === undefined)
        return Response.json({ id: 'application-1', description: state.description })
      if (state.failDescriptionPatch) return new Response(null, { status: 500 })
      const body = decodeDescriptionBody(init.body)
      state.description = body.description
      patches.push(body.description)
      return new Response(null, { status: 200 })
    }
    if (url.includes('/channels/')) return Response.json({ name: channelName })
    return new Response(null, { status: 404 })
  })
  return {
    fetchMock,
    patches,
    description: () => state.description,
    replaceDescription: (description: string) => void (state.description = description),
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

it('truncates labels at Unicode code-point boundaries', () => {
  const label = sanitizeTaskLabel('🚀'.repeat(100))
  assert.strictEqual(label, `${'🚀'.repeat(ActivityLabelLimit - 1)}…`)
  assert.strictEqual(Array.from(label).length, ActivityLabelLimit)
  assert.strictEqual(label.includes('\uFFFD'), false)
})

it('uses the larger valid Discord 429 delay', () => {
  const now = Date.parse('2026-03-21T10:00:00.000Z')
  assert.strictEqual(retryAfterMilliseconds('1.5', '{"retry_after":2.25}', now), 2_250)
  assert.strictEqual(
    retryAfterMilliseconds('Sat, 21 Mar 2026 10:00:03 GMT', '{"retry_after":1}', now),
    3_000,
  )
})

it('uses a conservative fallback for malformed Discord 429 timing', () => {
  assert.strictEqual(retryAfterMilliseconds('later', '{"retry_after":"soon"}', 0), 5_000)
  assert.strictEqual(retryAfterMilliseconds(null, '', 0), 5_000)
})

it('detects duplicate Discord application IDs and reports only connection IDs', () => {
  assert.deepStrictEqual(
    findDuplicateDiscordApplications([
      { connectionId: 'discord-a', applicationId: 'app-1', botToken: 'token-a' },
      { connectionId: 'discord-b', applicationId: 'app-1', botToken: 'token-b' },
      { connectionId: 'discord-c', applicationId: 'app-2', botToken: 'token-c' },
    ]),
    [['discord-a', 'discord-b']],
  )
})

it('detects duplicate Discord bot tokens and reports only connection IDs', () => {
  assert.deepStrictEqual(
    findDuplicateDiscordApplications([
      { connectionId: 'discord-a', applicationId: 'app-1', botToken: 'shared-secret' },
      { connectionId: 'discord-b', applicationId: 'app-2', botToken: 'shared-secret' },
      { connectionId: 'discord-c', applicationId: 'app-3', botToken: 'other-secret' },
    ]),
    [['discord-a', 'discord-b']],
  )
})

it('only recognizes descriptions owned by the same installation', () => {
  const description = 'Friday task activity [installation-a]:\n[#general] Work'
  assert.strictEqual(hasOwnedDescription(description, 'installation-a'), true)
  assert.strictEqual(hasOwnedDescription(description, 'installation-b'), false)
})

it.effect(
  'clears a stale owned description but preserves other installations and manual text',
  () =>
    withStubbedFetch(
      Effect.gen(function* () {
        const owned = makeDiscordFetch(
          'Friday task activity [unknown-installation]:\n[#general] Stale task',
        )
        vi.stubGlobal('fetch', owned.fetchMock)
        yield* makeDiscordAgentActivity(discord, 'bot-token', { activityDescription: false })
        assert.deepStrictEqual(owned.patches, [''])

        vi.unstubAllGlobals()
        const other = makeDiscordFetch(
          'Friday task activity [another-installation]:\n[#general] Work',
        )
        vi.stubGlobal('fetch', other.fetchMock)
        yield* makeDiscordAgentActivity(discord, 'bot-token', { activityDescription: false })
        assert.deepStrictEqual(other.patches, [])

        vi.unstubAllGlobals()
        const manual = makeDiscordFetch('Administrator-authored description')
        vi.stubGlobal('fetch', manual.fetchMock)
        yield* makeDiscordAgentActivity(discord, 'bot-token', { activityDescription: false })
        assert.deepStrictEqual(manual.patches, [])
      }),
    ),
)

it.effect('does not overwrite another installation description', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const other = makeDiscordFetch(
        'Friday task activity [another-installation]:\n[#general] Existing work',
      )
      vi.stubGlobal('fetch', other.fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
        installationId: 'this-installation',
        descriptionDebounce: '1 second',
      })

      yield* activity({ binding, taskId: 'task-1', active: true, task: 'New work' })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(other.patches, [])
    }),
  ),
)

it.effect('coalesces task transitions into one debounced description patch', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
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
        'Friday task activity [unknown-installation]:\n[#general] Implement the packing tests\n[#general] Review the adapter',
      ])
      assert.strictEqual(
        fetchMock.mock.calls.filter(
          ([url, init]) => url.endsWith('/applications/@me') && init?.body !== undefined,
        ).length,
        1,
      )

      yield* activity({ binding, taskId: 'task-1', active: false })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [
        'Friday task activity [unknown-installation]:\n[#general] Implement the packing tests\n[#general] Review the adapter',
        'Friday task activity [unknown-installation]:\n[#general] Review the adapter',
      ])

      // Finishing an unknown task changes nothing, so the unchanged output is skipped.
      yield* activity({ binding, taskId: 'task-3', active: false })
      yield* TestClock.adjust('1 second')
      assert.strictEqual(patches.length, 2)
    }),
  ),
)

it.effect('truncates channel names at Unicode code-point boundaries', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches } = makeDiscordFetch('', '🚀'.repeat(40))
      vi.stubGlobal('fetch', fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
        descriptionDebounce: '1 second',
      })

      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Test emoji channel' })
      yield* TestClock.adjust('1 second')
      assert.strictEqual(
        patches[0],
        `Friday task activity [unknown-installation]:\n[#${'🚀'.repeat(32)}] Test emoji channel`,
      )
      assert.strictEqual(patches[0]?.includes('\uFFFD'), false)
    }),
  ),
)

it.effect('overflows with complete lines and an accurate hidden-task count', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
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
      assert.strictEqual(lines[0], 'Friday task activity [unknown-installation]:')
      assert.strictEqual(lines[1], `[#general] ${'x'.repeat(63)}…`)
      assert.strictEqual(lines[4], `[#general] ${'x'.repeat(63)}…`)
      assert.strictEqual(lines[5], '... 3 more tasks.')
      assert(Array.from(patches[0] ?? '').length <= 400)

      yield* activity({ binding, taskId: 'task-7', active: false })
      yield* TestClock.adjust('1 second')
      const reflowed = patches[1]?.split('\n') ?? []
      assert.strictEqual(reflowed[5], '... 2 more tasks.')
    }),
  ),
)

it.effect('honors Retry-After and publishes the newest desired state on retry', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const attempted: Array<string> = []
      let patchAttempt = 0
      const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith('/applications/@me') && init?.body === undefined) {
          return Response.json({ id: 'application-1', description: '' })
        }
        if (url.endsWith('/applications/@me')) {
          attempted.push(decodeDescriptionBody(init?.body ?? '').description)
          patchAttempt += 1
          return patchAttempt === 1
            ? new Response(null, { status: 429, headers: { 'Retry-After': '2' } })
            : new Response(null, { status: 200 })
        }
        if (url.includes('/channels/')) return Response.json({ name: 'general' })
        return new Response(null, { status: 404 })
      })
      vi.stubGlobal('fetch', fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
        descriptionDebounce: '1 second',
      })

      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Old desired state' })
      yield* TestClock.adjust('1 second')
      yield* activity({ binding, taskId: 'task-1', active: false })
      yield* activity({ binding, taskId: 'task-2', active: true, task: 'Newest desired state' })
      yield* TestClock.adjust('2 seconds')

      assert.deepStrictEqual(attempted, [
        'Friday task activity [unknown-installation]:\n[#general] Old desired state',
        'Friday task activity [unknown-installation]:\n[#general] Newest desired state',
      ])
    }),
  ),
)

it.effect('stops after four PATCH attempts until a new activity transition', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches, setFail } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
        descriptionDebounce: '1 second',
        retryDelay: '1 second',
      })

      setFail(true)
      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Implement the feature' })
      yield* TestClock.adjust('4 seconds')
      const patchRequests = () =>
        fetchMock.mock.calls.filter(
          ([url, init]) => url.endsWith('/applications/@me') && init?.body !== undefined,
        ).length
      assert.strictEqual(patchRequests(), 4)
      yield* TestClock.adjust('30 seconds')
      assert.strictEqual(patchRequests(), 4)

      setFail(false)
      yield* activity({ binding, taskId: 'task-2', active: true, task: 'Converge now' })
      yield* TestClock.adjust('1 second')
      assert.strictEqual(patchRequests(), 5)
      assert.deepStrictEqual(patches, [
        'Friday task activity [unknown-installation]:\n[#general] Implement the feature\n[#general] Converge now',
      ])
    }),
  ),
)

it.effect('skips description updates when disabled by configuration', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const { fetchMock, patches } = makeDiscordFetch()
      vi.stubGlobal('fetch', fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: false,
        descriptionDebounce: '1 second',
      })

      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Implement the feature' })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [])
      assert.strictEqual(
        fetchMock.mock.calls.filter(
          ([url, init]) => url.includes('/applications/@me') && init?.body !== undefined,
        ).length,
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
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
        descriptionDebounce: '1 second',
      })

      yield* activity({ binding, taskId: 'task-1', active: true })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [
        'Friday task activity [unknown-installation]:\n[#general] Working...',
      ])
    }),
  ),
)

it.effect('re-reads ownership immediately before a publish PATCH', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      let applicationReads = 0
      const patches: Array<string> = []
      const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith('/applications/@me') && init?.body === undefined) {
          applicationReads += 1
          return Response.json({
            id: 'application-1',
            description: applicationReads >= 2 ? 'Administrator replacement' : '',
          })
        }
        if (url.endsWith('/applications/@me')) {
          patches.push(decodeDescriptionBody(init?.body ?? '').description)
          return new Response(null, { status: 200 })
        }
        if (url.includes('/channels/')) return Response.json({ name: 'general' })
        return new Response(null, { status: 404 })
      })
      vi.stubGlobal('fetch', fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
        installationId: 'this-installation',
        descriptionDebounce: '1 second',
      })
      yield* activity({ binding, taskId: 'task-1', active: true, task: 'New work' })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(patches, [])
      assert.strictEqual(applicationReads, 2)
    }),
  ),
)

it.effect('does not clear a description replaced during startup cleanup', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      let applicationReads = 0
      const patches: Array<string> = []
      const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
        if (url.endsWith('/applications/@me') && init?.body === undefined) {
          applicationReads += 1
          return Response.json({
            id: 'application-1',
            description:
              applicationReads === 1
                ? 'Friday task activity [this-installation]:\n[#general] Stale'
                : 'Administrator replacement',
          })
        }
        if (url.endsWith('/applications/@me')) {
          patches.push(decodeDescriptionBody(init?.body ?? '').description)
          return new Response(null, { status: 200 })
        }
        return new Response(null, { status: 404 })
      })
      vi.stubGlobal('fetch', fetchMock)
      yield* makeDiscordAgentActivity(discord, 'bot-token', {
        installationId: 'this-installation',
      })
      assert.deepStrictEqual(patches, [])
      assert.strictEqual(applicationReads, 2)
    }),
  ),
)

it.effect('preserves a remote replacement when the final task completes', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const remote = makeDiscordFetch()
      vi.stubGlobal('fetch', remote.fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
        installationId: 'this-installation',
        descriptionDebounce: '1 second',
      })
      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Finishing work' })
      yield* TestClock.adjust('1 second')
      remote.replaceDescription('Administrator replacement')
      yield* activity({ binding, taskId: 'task-1', active: false })
      yield* TestClock.adjust('1 second')
      assert.strictEqual(remote.description(), 'Administrator replacement')
      assert.deepStrictEqual(remote.patches, [
        'Friday task activity [this-installation]:\n[#general] Finishing work',
      ])
    }),
  ),
)

it.effect('applies activity-description set and reset without restarting', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const remote = makeDiscordFetch()
      let updateFlag: ((enabled: boolean) => Effect.Effect<void>) | undefined
      vi.stubGlobal('fetch', remote.fetchMock)
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: false,
        descriptionDebounce: '1 second',
        watchActivityDescription: (onChange) =>
          Effect.sync(() => {
            updateFlag = onChange
          }),
      })
      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Live setting' })
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(remote.patches, [])

      assert(updateFlag !== undefined)
      yield* updateFlag(true)
      yield* TestClock.adjust('1 second')
      assert.deepStrictEqual(remote.patches, [
        'Friday task activity [unknown-installation]:\n[#general] Live setting',
      ])

      yield* updateFlag(false)
      assert.deepStrictEqual(remote.patches, [
        'Friday task activity [unknown-installation]:\n[#general] Live setting',
        '',
      ])
      yield* TestClock.adjust('10 seconds')
      assert.strictEqual(remote.patches.length, 2)
    }),
  ),
)

it.effect('clears its owned description during normal scope shutdown', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const remote = makeDiscordFetch()
      vi.stubGlobal('fetch', remote.fetchMock)
      const scope = yield* Scope.make()
      const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
        activityDescription: true,
        descriptionDebounce: '1 second',
      }).pipe(Effect.provideService(Scope.Scope, scope))
      yield* activity({ binding, taskId: 'task-1', active: true, task: 'Shutdown cleanup' })
      yield* TestClock.adjust('1 second')
      assert(remote.description().includes('Shutdown cleanup'))
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(remote.description(), '')
    }),
  ),
)

it.effect('clears publication when the owning scope unwinds after failure', () =>
  withStubbedFetch(
    Effect.gen(function* () {
      const remote = makeDiscordFetch()
      vi.stubGlobal('fetch', remote.fetchMock)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const activity = yield* makeDiscordAgentActivity(discord, 'bot-token', {
            activityDescription: true,
            descriptionDebounce: '1 second',
          })
          yield* activity({ binding, taskId: 'task-1', active: true, task: 'Failure cleanup' })
          yield* TestClock.adjust('1 second')
          return yield* Effect.fail('startup-failed')
        }),
      ).pipe(Effect.flip)
      assert.strictEqual(remote.description(), '')
      assert.deepStrictEqual(remote.patches, [
        'Friday task activity [unknown-installation]:\n[#general] Failure cleanup',
        '',
      ])
    }),
  ),
)
