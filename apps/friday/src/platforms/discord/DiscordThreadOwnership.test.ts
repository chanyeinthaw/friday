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
    const should = yield* shouldTitleDiscordThread(
      // SAFETY: the ownership check only reads decodeThreadId and
      // fetchChannelInfo; the wider DiscordAdapter surface is never touched.
      discordStub({ id: THREAD, parent_id: CHANNEL, type: 11, owner_id: APPLICATION_ID }) as never,
      APPLICATION_ID,
      inputFor(threadBinding()),
    )
    assert.strictEqual(should, true)
  }),
)

it.effect('skips a Discord thread owned by another user', () =>
  Effect.gen(function* () {
    const should = yield* shouldTitleDiscordThread(
      // SAFETY: same narrow adapter surface as above.
      discordStub({
        id: THREAD,
        parent_id: CHANNEL,
        type: 11,
        owner_id: '111111111111111111',
      }) as never,
      APPLICATION_ID,
      inputFor(threadBinding()),
    )
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
