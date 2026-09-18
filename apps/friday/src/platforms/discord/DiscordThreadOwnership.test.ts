/* oxlint-disable anti-slop/no-unknown-parameters -- Test helper forwards canned Discord channel payloads to the ownership decoder. */
import { assert, it } from '@effect/vitest'
import { ConversationBinding, InputMessage } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { shouldTitleDiscordThread } from './DiscordThreadOwnership.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeMessage = Schema.decodeSync(InputMessage)

const APPLICATION_ID = '999999999999999999'
const GUILD = '111111111111111111'
const CHANNEL = '222222222222222222'
const THREAD = '333333333333333333'

const inputFor = (binding: ReturnType<typeof decodeBinding>): PlatformInput => ({
  binding,
  message: decodeMessage({
    source: 'user',
    content: { text: 'Hello Friday', images: [] },
    platformMessageId: 'message-1',
  }),
})

const threadBinding = () =>
  decodeBinding({
    platform: 'discord',
    connectionId: 'discord',
    channelId: `discord:${GUILD}:${CHANNEL}`,
    sourceMessageId: 'message-1',
    conversationId: `discord:${GUILD}:${CHANNEL}:${THREAD}`,
  })

const channelBinding = () =>
  decodeBinding({
    platform: 'discord',
    connectionId: 'discord',
    channelId: `discord:${GUILD}:${CHANNEL}`,
    sourceMessageId: 'message-1',
    conversationId: `discord:${GUILD}:${CHANNEL}:${CHANNEL}`,
  })

const threadLocation = { guildId: GUILD, channelId: CHANNEL, threadId: THREAD }
const channelLocation = { guildId: GUILD, channelId: CHANNEL, threadId: CHANNEL }

const THREAD_CHANNEL_ID = `discord:${GUILD}:${THREAD}`
const THREAD_CONVERSATION_ID = `discord:${GUILD}:${CHANNEL}:${THREAD}`

const discordStub = (raw: unknown) => ({
  decodeThreadId: () => threadLocation,
  fetchChannelInfo: (_conversationId: string) =>
    Promise.resolve({
      id: _conversationId,
      name: 'thread',
      isDM: false,
      metadata: { raw },
    }),
})

it.effect('titles a Discord thread owned by Friday', () =>
  Effect.gen(function* () {
    let fetchedId: string | undefined
    const discord = {
      decodeThreadId: () => threadLocation,
      fetchChannelInfo: (channelId: string) => {
        fetchedId = channelId
        return Promise.resolve({
          id: channelId,
          name: 'thread',
          isDM: false,
          metadata: { raw: { id: THREAD, parent_id: CHANNEL, type: 11, owner_id: APPLICATION_ID } },
        })
      },
    }
    const should = yield* shouldTitleDiscordThread(
      // SAFETY: the ownership check only reads decodeThreadId and
      // fetchChannelInfo; the wider DiscordAdapter surface is never touched.
      discord as never,
      APPLICATION_ID,
      inputFor(threadBinding()),
    )
    assert.strictEqual(fetchedId, THREAD_CHANNEL_ID)
    assert.strictEqual(should, true)
  }),
)

it.effect('reads ownership from the thread when the parent has no owner', () =>
  Effect.gen(function* () {
    let fetchedId: string | undefined
    const discord = {
      decodeThreadId: () => threadLocation,
      fetchChannelInfo: (channelId: string) => {
        fetchedId = channelId
        const raw =
          channelId === THREAD_CHANNEL_ID
            ? { id: THREAD, parent_id: CHANNEL, type: 11, owner_id: APPLICATION_ID }
            : { id: CHANNEL, type: 0 }
        return Promise.resolve({
          id: channelId,
          name: 'thread',
          isDM: false,
          metadata: { raw },
        })
      },
    }
    const should = yield* shouldTitleDiscordThread(
      // SAFETY: same narrow adapter surface as above.
      discord as never,
      APPLICATION_ID,
      inputFor(threadBinding()),
    )
    // A four-part conversation id would fetch the parent channel, which
    // has no owner; the thread-scoped three-part id returns Friday as owner.
    assert.strictEqual(fetchedId, THREAD_CHANNEL_ID)
    assert.notStrictEqual(fetchedId, THREAD_CONVERSATION_ID)
    assert.strictEqual(should, true)
  }),
)

it.effect('skips a Discord thread owned by another user', () =>
  Effect.gen(function* () {
    let fetchedId: string | undefined
    const discord = {
      decodeThreadId: () => threadLocation,
      fetchChannelInfo: (channelId: string) => {
        fetchedId = channelId
        return Promise.resolve({
          id: channelId,
          name: 'thread',
          isDM: false,
          metadata: {
            raw: {
              id: THREAD,
              parent_id: CHANNEL,
              type: 11,
              owner_id: '111111111111111111',
            },
          },
        })
      },
    }
    const should = yield* shouldTitleDiscordThread(
      // SAFETY: same narrow adapter surface as above.
      discord as never,
      APPLICATION_ID,
      inputFor(threadBinding()),
    )
    assert.strictEqual(fetchedId, THREAD_CHANNEL_ID)
    assert.strictEqual(should, false)
  }),
)

it.effect('skips channel-sentinel conversations without fetching thread ownership', () =>
  Effect.gen(function* () {
    let fetched = false
    const discord = {
      decodeThreadId: () => channelLocation,
      fetchChannelInfo: (_conversationId: string) => {
        fetched = true
        return Promise.reject(new Error('should not fetch'))
      },
    }
    const should = yield* shouldTitleDiscordThread(
      // SAFETY: same narrow adapter surface as above.
      discord as never,
      APPLICATION_ID,
      inputFor(channelBinding()),
    )
    assert.strictEqual(should, false)
    assert.strictEqual(fetched, false)
  }),
)

it.effect('skips when thread ownership cannot be determined', () =>
  Effect.gen(function* () {
    const missingOwner = yield* shouldTitleDiscordThread(
      // SAFETY: same narrow adapter surface as above.
      discordStub({ id: THREAD, parent_id: CHANNEL, type: 11 }) as never,
      APPLICATION_ID,
      inputFor(threadBinding()),
    )
    assert.strictEqual(missingOwner, false)

    const fetchFailed = yield* shouldTitleDiscordThread(
      // SAFETY: same narrow adapter surface as above.
      {
        decodeThreadId: () => threadLocation,
        fetchChannelInfo: () => Promise.reject(new Error('Discord 500')),
      } as never,
      APPLICATION_ID,
      inputFor(threadBinding()),
    )
    assert.strictEqual(fetchFailed, false)
  }),
)
