import { assert, it } from '@effect/vitest'
import { ConversationBinding, PlatformConnectionId } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'

import type { PlatformAdapter } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'
import {
  type DiscordThreadTitleAdapter,
  withDiscordThreadActivityTitle,
} from './DiscordThreadActivityTitle.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const threadBinding = decodeBinding({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'm-1',
  conversationId: 'discord:guild-1:channel-1:thread-1',
})
const secondThreadBinding = decodeBinding({
  ...threadBinding,
  sourceMessageId: 'm-2',
  conversationId: 'discord:guild-1:channel-1:thread-2',
})
const channelBinding = decodeBinding({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  sourceMessageId: 'm-1',
  conversationId: 'discord:guild-1:channel-1',
})

interface DiscordStub extends DiscordThreadTitleAdapter {
  readonly names: Map<string, string | null>
  readonly renames: Array<{ readonly conversationId: string; readonly name: string }>
  readonly requests: Array<string>
}

const stubDiscord = (initialNames: Readonly<Record<string, string | null>>): DiscordStub => {
  const names = new Map(Object.entries(initialNames))
  const renames: DiscordStub['renames'] = []
  const requests: Array<string> = []
  return {
    names,
    renames,
    requests,
    decodeThreadId: (id) => {
      const [, guildId, channelId, threadId] = id.split(':')
      return { guildId, channelId, threadId }
    },
    encodeThreadId: ({ guildId, channelId, threadId }) =>
      ['discord', guildId, channelId, threadId].filter((part) => part !== undefined).join(':'),
    fetchThread: (id) => {
      requests.push(`GET ${id}`)
      return Promise.resolve({ channelName: names.get(id) ?? undefined })
    },
    setThreadTitle: (id, name) => {
      requests.push(`PATCH ${id}`)
      renames.push({ conversationId: id, name })
      const [, guildId, , threadId] = id.split(':')
      names.set(`discord:${guildId}:${threadId}`, name)
      return Promise.resolve()
    },
  }
}

const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)

const makeInnerPlatform = (calls: Array<string>): PlatformAdapter<ChatSdkPublicationError> => ({
  connectionId: decodeConnectionId('discord'),
  kind: 'discord',
  publish: () => Effect.void,
  acknowledge: () => Effect.void,
  beginWorking: ({ binding }) =>
    Effect.sync(() => {
      calls.push(`beginWorking:${binding.conversationId}`)
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

const initialThreadNames = (name: string | null) => ({
  'discord:guild-1:thread-1': name,
})

const makePlatform = (discord: DiscordThreadTitleAdapter, calls: Array<string>) =>
  withDiscordThreadActivityTitle(discord, makeInnerPlatform(calls))

it.effect('prefixes the thread title while a turn runs and restores it afterwards', () =>
  Effect.gen(function* () {
    const stub = stubDiscord(initialThreadNames('Design Review'))
    const calls: Array<string> = []
    const platform = makePlatform(stub, calls)

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review'],
    )

    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Done' })
    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review', 'Design Review'],
    )
    assert.deepStrictEqual(calls, [
      `beginWorking:${threadBinding.conversationId}`,
      'finalizeWorking',
    ])
  }),
)

it.effect('keeps the prefix while a task outlives the turn without redundant renames', () =>
  Effect.gen(function* () {
    const stub = stubDiscord(initialThreadNames('Design Review'))
    const platform = makePlatform(stub, [])

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-1', active: true })
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Spawned task' })
    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review'],
    )

    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-1', active: false })
    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review', 'Design Review'],
    )
  }),
)

it.effect('overlapping tasks keep the prefix until the last task finishes', () =>
  Effect.gen(function* () {
    const stub = stubDiscord(initialThreadNames('Design Review'))
    const platform = makePlatform(stub, [])

    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-1', active: true })
    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-2', active: true })
    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-1', active: false })
    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review'],
    )

    yield* platform.setAgentActivity({ binding: threadBinding, taskId: 'task-2', active: false })
    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review', 'Design Review'],
    )
  }),
)

it.effect('strips a stale prefix instead of duplicating it', () =>
  Effect.gen(function* () {
    const stub = stubDiscord(initialThreadNames('⚡ Design Review'))
    const platform = makePlatform(stub, [])

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Done' })
    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review', 'Design Review'],
    )
  }),
)

it.effect('applies generated titles under the active prefix', () =>
  Effect.gen(function* () {
    const stub = stubDiscord(initialThreadNames('Design Review'))
    const platform = makePlatform(stub, [])

    yield* platform.setConversationTitle({ binding: threadBinding, title: 'New Title' })
    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })

    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['New Title', '⚡ New Title'],
    )
  }),
)

it.effect('evicts idle state so a later activity cycle fetches the current title again', () =>
  Effect.gen(function* () {
    const stub = stubDiscord(initialThreadNames('Design Review'))
    const platform = makePlatform(stub, [])

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Done' })
    stub.names.set('discord:guild-1:thread-1', 'Externally Renamed')

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking again...' })
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Done again' })

    assert.deepStrictEqual(
      stub.requests.filter((request) => request.startsWith('GET')),
      [
        'GET discord:guild-1:thread-1',
        'GET discord:guild-1:thread-1',
        'GET discord:guild-1:thread-1',
        'GET discord:guild-1:thread-1',
      ],
    )
    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review', 'Design Review', '⚡ Externally Renamed', 'Externally Renamed'],
    )
  }),
)

it.effect('waits for a delayed active rename before restoring the idle title', () =>
  Effect.gen(function* () {
    const activeRenameStarted = Promise.withResolvers<void>()
    const releaseActiveRename = Promise.withResolvers<void>()
    const stub = stubDiscord(initialThreadNames('Design Review'))
    const adapter: DiscordThreadTitleAdapter = {
      ...stub,
      setThreadTitle: (id, name) => {
        if (name === '⚡ Design Review') {
          activeRenameStarted.resolve()
          return releaseActiveRename.promise.then(() => stub.setThreadTitle(id, name))
        }
        return stub.setThreadTitle(id, name)
      },
    }
    const platform = makePlatform(adapter, [])

    const begin = yield* platform
      .beginWorking({ binding: threadBinding, text: '-# Thinking...' })
      .pipe(Effect.forkChild)
    yield* Effect.promise(() => activeRenameStarted.promise)
    const finalize = yield* platform
      .finalizeWorking({ binding: threadBinding, text: 'Done' })
      .pipe(Effect.forkChild)
    yield* Effect.yieldNow

    assert.deepStrictEqual(stub.renames, [])
    releaseActiveRename.resolve()
    yield* Fiber.join(begin)
    yield* Fiber.join(finalize)

    assert.deepStrictEqual(
      stub.renames.map(({ name }) => name),
      ['⚡ Design Review', 'Design Review'],
    )
    assert.strictEqual(stub.names.get('discord:guild-1:thread-1'), 'Design Review')
  }),
)

it.effect('does not split a Unicode surrogate pair at the Discord title boundary', () =>
  Effect.gen(function* () {
    const name = `${'a'.repeat(97)}😀suffix`
    const stub = stubDiscord(initialThreadNames(name))
    const platform = makePlatform(stub, [])

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })

    const applied = stub.renames[0]?.name
    assert.strictEqual(applied, `⚡ ${'a'.repeat(97)}😀`)
    assert.strictEqual(Array.from(applied ?? '').length, 100)
    assert.notMatch(applied ?? '', /[\uD800-\uDBFF]$/u)
  }),
)

it.effect('serializes per thread so a hanging lookup cannot block another thread', () =>
  Effect.gen(function* () {
    const hangingLookup = Promise.withResolvers<{ readonly channelName?: string }>()
    const calls: Array<string> = []
    const stub = stubDiscord({ 'discord:guild-1:thread-2': 'Second Thread' })
    const adapter: DiscordThreadTitleAdapter = {
      ...stub,
      fetchThread: (id) =>
        id === 'discord:guild-1:thread-1' ? hangingLookup.promise : stub.fetchThread(id),
    }
    const platform = makePlatform(adapter, calls)

    const stalled = yield* platform
      .beginWorking({ binding: threadBinding, text: '-# Thinking...' })
      .pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* platform.beginWorking({ binding: secondThreadBinding, text: '-# Thinking...' })

    assert.deepStrictEqual(stub.renames, [
      { conversationId: String(secondThreadBinding.conversationId), name: '⚡ Second Thread' },
    ])
    assert.include(calls, `beginWorking:${secondThreadBinding.conversationId}`)
    hangingLookup.resolve({ channelName: 'First Thread' })
    yield* Fiber.join(stalled)
  }),
)

it.effect('leaves non-thread conversations untouched', () =>
  Effect.gen(function* () {
    const stub = stubDiscord(initialThreadNames('General'))
    const calls: Array<string> = []
    const platform = makePlatform(stub, calls)

    yield* platform.beginWorking({ binding: channelBinding, text: '-# Thinking...' })
    yield* platform.setAgentActivity({ binding: channelBinding, taskId: 'task-1', active: true })
    yield* platform.setConversationTitle({ binding: channelBinding, title: 'General' })
    yield* platform.finalizeWorking({ binding: channelBinding, text: 'Done' })

    assert.deepStrictEqual(stub.requests, [])
    assert.deepStrictEqual(calls, [
      `beginWorking:${channelBinding.conversationId}`,
      'activity:task-1:true',
      'title:General',
      'finalizeWorking',
    ])
  }),
)

it.effect('keeps wrapped operations working when Discord title calls fail', () =>
  Effect.gen(function* () {
    const calls: Array<string> = []
    const adapter: DiscordThreadTitleAdapter = {
      ...stubDiscord(initialThreadNames('Design Review')),
      fetchThread: () => Promise.reject(new Error('lookup failed')),
      setThreadTitle: () => Promise.reject(new Error('rename failed')),
    }
    const platform = makePlatform(adapter, calls)

    yield* platform.beginWorking({ binding: threadBinding, text: '-# Thinking...' })
    yield* platform.finalizeWorking({ binding: threadBinding, text: 'Done' })
    assert.deepStrictEqual(calls, [
      `beginWorking:${threadBinding.conversationId}`,
      'finalizeWorking',
    ])
  }),
)
