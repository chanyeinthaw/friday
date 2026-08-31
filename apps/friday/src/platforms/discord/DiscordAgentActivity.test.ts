import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import { afterEach, vi } from 'vitest'

import { makeDiscordAgentActivity } from './DiscordAgentActivity.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const binding = decodeBinding({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'discord:guild-1:channel-1:thread-1',
})

const decodeNicknameBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ nick: Schema.String })),
)

const response = (body: Schema.Json, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const adapter = {
  decodeThreadId: (id: string) => {
    const [, guildId] = id.split(':')
    return { guildId }
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it.effect('serializes shared Discord nickname state by guild', () =>
  Effect.gen(function* () {
    const firstPatchStarted = Promise.withResolvers<void>()
    const releaseFirstPatch = Promise.withResolvers<void>()
    const nicknames: Array<string> = []
    let patchCount = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { readonly body?: string }) => {
        if (url.endsWith('/users/@me')) return Promise.resolve(response({ id: 'bot-1' }))
        if (url.endsWith('/members/bot-1')) {
          return Promise.resolve(response({ nick: 'Friday', user: { username: 'Friday' } }))
        }
        const nickname = decodeNicknameBody(init?.body ?? '').nick
        nicknames.push(nickname)
        patchCount += 1
        if (patchCount === 1) {
          firstPatchStarted.resolve()
          return releaseFirstPatch.promise.then(() => response({}))
        }
        return Promise.resolve(response({}))
      }),
    )
    const setActivity = makeDiscordAgentActivity(adapter, 'token')

    const first = yield* setActivity({ binding, taskId: 'task-1', active: true }).pipe(
      Effect.forkChild,
    )
    yield* Effect.promise(() => firstPatchStarted.promise)
    const second = yield* setActivity({ binding, taskId: 'task-2', active: true }).pipe(
      Effect.forkChild,
    )
    yield* Effect.yieldNow
    assert.deepStrictEqual(nicknames, ['Friday ⚡️'])

    releaseFirstPatch.resolve()
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    assert.deepStrictEqual(nicknames, ['Friday ⚡️', 'Friday ⚡️x2'])
  }),
)

it.effect('evicts idle guild state even when the idle nickname update fails', () =>
  Effect.gen(function* () {
    let memberLookups = 0
    let failIdlePatch = true
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: { readonly body?: string }) => {
        if (url.endsWith('/users/@me')) return Promise.resolve(response({ id: 'bot-1' }))
        if (url.endsWith('/members/bot-1')) {
          memberLookups += 1
          return Promise.resolve(response({ nick: 'Friday', user: { username: 'Friday' } }))
        }
        const nickname = decodeNicknameBody(init?.body ?? '').nick
        if (nickname === 'Friday' && failIdlePatch) {
          failIdlePatch = false
          return Promise.resolve(response({}, 500))
        }
        return Promise.resolve(response({}))
      }),
    )
    const setActivity = makeDiscordAgentActivity(adapter, 'token')

    yield* setActivity({ binding, taskId: 'task-1', active: true })
    yield* Effect.flip(setActivity({ binding, taskId: 'task-1', active: false }))
    yield* setActivity({ binding, taskId: 'task-2', active: true })

    assert.strictEqual(memberLookups, 2)
  }),
)
