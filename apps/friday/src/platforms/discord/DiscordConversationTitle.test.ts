import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { setDiscordConversationTitle } from './DiscordConversationTitle.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const binding = (conversationId: string) =>
  decodeBinding({
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'discord:guild-1:channel-1',
    sourceMessageId: 'message-1',
    conversationId,
  })

it.effect('does not rename a channel-sentinel conversation', () =>
  Effect.gen(function* () {
    const renames: Array<string> = []
    yield* setDiscordConversationTitle(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'channel-1',
        }),
        setThreadTitle: (id: string) => {
          renames.push(id)
          return Promise.resolve()
        },
      },
      { binding: binding('discord:guild-1:channel-1:channel-1'), title: 'General' },
    )

    assert.deepStrictEqual(renames, [])
  }),
)

it.effect('renames a real Discord thread', () =>
  Effect.gen(function* () {
    const renames: Array<string> = []
    yield* setDiscordConversationTitle(
      {
        decodeThreadId: () => ({
          guildId: 'guild-1',
          channelId: 'channel-1',
          threadId: 'thread-1',
        }),
        setThreadTitle: (id: string) => {
          renames.push(id)
          return Promise.resolve()
        },
      },
      { binding: binding('discord:guild-1:channel-1:thread-1'), title: 'Review' },
    )

    assert.deepStrictEqual(renames, ['discord:guild-1:channel-1:thread-1'])
  }),
)
