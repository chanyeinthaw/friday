import { assert, it } from '@effect/vitest'
import { ConversationBinding, PlatformConnectionId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { afterEach, vi } from 'vitest'

import type { PlatformAdapter } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import { withDiscordThreadActivityTitle } from './DiscordThreadActivityTitle.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const threadBinding = decodeBinding({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'm-1',
  conversationId: 'discord:guild-1:channel-1:thread-1',
})
const channelBinding = decodeBinding({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'm-1',
  conversationId: 'discord:guild-1:channel-1',
})

const discordAdapter = {
  decodeThreadId: (id: string) => {
    const [, , channelId, threadId] = id.split(':')
    return { guildId: 'guild-1', channelId: channelId ?? '', threadId }
  },
}

const RenameBody = Schema.fromJsonString(Schema.Struct({ name: Schema.String }))
const decodeRenameBody = Schema.decodeUnknownSync(RenameBody)

interface DiscordStub {
  readonly renames: Array<string>
  readonly requests: Array<string>
}

const stubDiscord = (threadName: string | null, renameStatus = 200): DiscordStub => {
  const renames: Array<string> = []
  const requests: Array<string> = []
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${String(input)}`)
    if (method === 'PATCH') {
      renames.push(decodeRenameBody(init?.body).name)
      return Promise.resolve(new Response(null, { status: renameStatus }))
    }
    return Promise.resolve(Response.json(threadName === null ? {} : { name: threadName }))
  })
  return { renames, requests }
}

const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)

const makeInnerPlatform = (calls: Array<string>): PlatformAdapter<ChatSdkPublicationError> => ({
  connectionId: decodeConnectionId('discord'),
  kind: 'discord',
  publish: () => Effect.void,
  acknowledge: () => Effect.void,
  beginWorking: () =>
    Effect.sync(() => {
      calls.push('beginWorking')
    }),
  updateWorking: () => Effect.void,
  finalizeWorking: () =>
    Effect.sync(() => {
      calls.push('finalizeWorking')
    }),
  discardWorking: () =>
    Effect.sync(() => {
      calls.push('discardWorking')
    }),
  setConversationTitle: ({ title }) =>
    Effect.sync(() => {
      calls.push(`title:${title}`)
    }),
  setAgentActivity: ({ taskId, active }) =>
    Effect.sync(() => {
      calls.push(`activity:${taskId}:${String(active)}`)
    }),
  searchMessages: () => Effect.succeed({ messages: [], scannedCount: 0, truncated: false }),
  withTyping: (_binding, effect) => effect,
})

const makePlatform = (calls: Array<string>) =>
  withDiscordThreadActivityTitle(discordAdapter, 'bot-token', makeInnerPlatform(calls))

afterEach(() => {
  vi.unstubAllGlobals()
})

it.effect('prefixes the thread title while a turn runs and restores it afterwards', () =>
  Effect.gen(function* () {
    const stub = stubDiscord('Design Review')
    const calls: Array<string> = []
    const platform = makePlatform(calls)

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review'])
    assert.deepStrictEqual(calls, ['beginWorking'])

    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Done' })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review', 'Design Review'])
    assert.deepStrictEqual(calls, ['beginWorking', 'finalizeWorking'])
  }),
)

it.effect('keeps the prefix while a task outlives the turn without renaming repeatedly', () =>
  Effect.gen(function* () {
    const stub = stubDiscord('Design Review')
    const platform = makePlatform([])

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-1', active: true })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review'])

    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Spawned task' })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review'])

    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-1', active: false })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review', 'Design Review'])
  }),
)

it.effect('overlapping tasks share a single prefix and keep it until the last one finishes', () =>
  Effect.gen(function* () {
    const stub = stubDiscord('Design Review')
    const platform = makePlatform([])

    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-1', active: true })
    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-2', active: true })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review'])

    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-1', active: false })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review'])

    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-2', active: false })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review', 'Design Review'])
  }),
)

it.effect('strips a stale prefix instead of duplicating it and preserves the base title', () =>
  Effect.gen(function* () {
    const stub = stubDiscord('⚡ Design Review')
    const platform = makePlatform([])

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review'])

    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Done' })
    assert.deepStrictEqual(stub.renames, ['⚡ Design Review', 'Design Review'])
  }),
)

it.effect('applies generated titles under the active prefix and reuses the known base', () =>
  Effect.gen(function* () {
    const stub = stubDiscord('Design Review')
    const calls: Array<string> = []
    const platform = makePlatform(calls)

    yield* platform.setConversationTitle({ binding: threadBinding, title: 'New Title' })
    assert.deepStrictEqual(stub.renames, ['New Title'])

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    assert.deepStrictEqual(stub.renames, ['New Title', '⚡ New Title'])
    assert.deepStrictEqual(
      stub.requests.filter((request) => request.startsWith('GET')),
      [],
    )
    assert.deepStrictEqual(calls, ['beginWorking'])
  }),
)

it.effect('renames generated titles without a prefix when the thread is idle', () =>
  Effect.gen(function* () {
    const stub = stubDiscord('Design Review')
    const platform = makePlatform([])

    yield* platform.setConversationTitle({ binding: threadBinding, title: 'Fresh Name' })
    assert.deepStrictEqual(stub.renames, ['Fresh Name'])
  }),
)

it.effect('leaves non-thread conversations untouched', () =>
  Effect.gen(function* () {
    const stub = stubDiscord('General')
    const calls: Array<string> = []
    const platform = makePlatform(calls)

    yield* platform.beginWorking({ binding: channelBinding, text: '-# Thinking...' })
    yield* platform.setAgentActivity({ binding: channelBinding, taskId: 'task-1', active: true })
    yield* platform.setConversationTitle({ binding: channelBinding, title: 'General' })
    yield* platform.finalizeWorking({ binding: channelBinding, text: 'Done' })

    assert.deepStrictEqual(stub.requests, [])
    assert.deepStrictEqual(stub.renames, [])
    assert.deepStrictEqual(calls, [
      'beginWorking',
      'activity:task-1:true',
      'title:General',
      'finalizeWorking',
    ])
  }),
)

it.effect('keeps wrapped operations working when Discord renames fail', () =>
  Effect.gen(function* () {
    stubDiscord('Design Review', 500)
    const calls: Array<string> = []
    const platform = makePlatform(calls)

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Done' })
    assert.deepStrictEqual(calls, ['beginWorking', 'finalizeWorking'])
  }),
)

it.effect('keeps wrapped operations working when Discord thread lookups fail', () =>
  Effect.gen(function* () {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 500 })))
    const calls: Array<string> = []
    const platform = makePlatform(calls)

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    assert.deepStrictEqual(calls, ['beginWorking'])
  }),
)
