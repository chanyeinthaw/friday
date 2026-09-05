import { assert, it } from '@effect/vitest'
import {
  ConversationBinding,
  ImageAttachment,
  InputMessage,
  PlatformConversationId,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import { loadDiscordInitialContext, shouldLoadDiscordContext } from './DiscordInitialContext.ts'

const decodeConversationId = Schema.decodeSync(PlatformConversationId)
const decodeImage = Schema.decodeSync(ImageAttachment)
const binding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'discord:guild-1:channel-1',
  conversationId: 'discord:guild-1:channel-1:thread-1',
  sourceMessageId: 'trigger-1',
})
const trigger = Schema.decodeSync(InputMessage)({
  source: 'user',
  author: {
    platformUserId: 'user-1',
    mention: '<@user-1>',
    username: 'chan',
    displayName: 'Chan',
  },
  content: { text: 'Friday, investigate.', images: [] },
  platformMessageId: 'trigger-1',
})
const author = (id: string, bot = false) => ({
  userId: id,
  userName: id,
  fullName: id,
  isBot: bot,
  isMe: bot,
})
const message = (
  id: string,
  text: string,
  bot = false,
  attachments?: ReadonlyArray<{
    readonly type: 'image'
    readonly url: string
    readonly name: string
    readonly mimeType: string
    readonly size: number
  }>,
) => {
  const historyMessage = { id, text, author: author(id, bot), attachments }
  if (attachments !== undefined) historyMessage.attachments = attachments
  return historyMessage
}

it('loads context for new bindings, mention-only invocations, and reply-in-channel transport', () => {
  assert.isTrue(
    shouldLoadDiscordContext({
      created: true,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-thread',
    }),
  )
  assert.isTrue(
    shouldLoadDiscordContext({
      created: false,
      invocationMode: 'mention-only',
      replyMode: 'reply-in-thread',
    }),
  )
  assert.isTrue(
    shouldLoadDiscordContext({
      created: false,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-channel',
    }),
  )
  assert.isFalse(
    shouldLoadDiscordContext({
      created: false,
      invocationMode: 'all-messages',
      replyMode: 'reply-in-thread',
    }),
  )
})

const load = (
  input: Parameters<typeof loadDiscordInitialContext>[2],
  messages: ReadonlyArray<ReturnType<typeof message>>,
  cursor: Parameters<typeof loadDiscordInitialContext>[3] = { created: true },
) => {
  const fetches: Array<{ readonly threadId: string; readonly options: unknown }> = []
  return loadDiscordInitialContext(
    {
      decodeThreadId: (conversationId) => {
        const segments = conversationId.split(':')
        return {
          guildId: segments[1] ?? '',
          channelId: segments[2] ?? '',
          threadId: segments[3] ?? '',
        }
      },
      encodeThreadId: ({ guildId, channelId, threadId }) =>
        `discord:${guildId}:${channelId}:${threadId}`,
      fetchMessages: (threadId, options) => {
        fetches.push({ threadId, options })
        return Promise.resolve({ messages })
      },
    },
    20,
    input,
    cursor,
  ).pipe(Effect.map((result) => ({ result, fetches })))
}

it.effect('fetches history backward from the current trigger and treats the page as history', () =>
  Effect.gen(function* () {
    const { result, fetches } = yield* load(
      { binding, message: trigger, discordHistorySource: 'thread' },
      [message('earlier-1', 'Earlier context.'), message('bot-1', 'Friday output.', true)],
    )

    assert.deepStrictEqual(fetches, [
      {
        threadId: 'discord:guild-1:channel-1:thread-1',
        options: { limit: 20, cursor: 'trigger-1', direction: 'backward' },
      },
    ])
    assert.deepStrictEqual(
      result.initialContext?.map(({ content }) => content.text),
      ['Earlier context.'],
    )
  }),
)

it.effect('preserves attachment metadata in fetched Discord history', () =>
  Effect.gen(function* () {
    const { result } = yield* load({ binding, message: trigger, discordHistorySource: 'thread' }, [
      message('earlier-1', 'See this.', false, [
        {
          type: 'image',
          url: 'https://cdn.discordapp.com/attachments/channel/attachment/history.png',
          name: 'history.png',
          mimeType: 'image/png',
          size: 321,
        },
      ]),
    ])

    assert.deepStrictEqual(result.initialContext?.[0]?.content, {
      text: 'See this.',
      images: [
        decodeImage({
          id: 'attachment-earlier-1-1',
          name: 'history.png',
          mediaType: 'image/png',
          sizeBytes: 321,
          storageReference: 'https://cdn.discordapp.com/attachments/channel/attachment/history.png',
        }),
      ],
    })
  }),
)

it.effect('returns no catch-up context when afterMessageId is absent from the bounded page', () =>
  Effect.gen(function* () {
    const { result } = yield* load(
      { binding, message: trigger, discordHistorySource: 'thread' },
      [message('missed-1', 'Unproven message.'), message('missed-2', 'Also unproven.')],
      { created: false, afterMessageId: 'message-before' },
    )

    assert.deepStrictEqual(result.initialContext, [])
  }),
)

it.effect('loads messages after a proven prior anchor', () =>
  Effect.gen(function* () {
    const { result } = yield* load(
      { binding, message: trigger, discordHistorySource: 'thread' },
      [
        message('message-before', 'Already ingested.'),
        message('missed-1', 'Missed one.'),
        message('missed-2', 'Missed two.'),
      ],
      { created: false, afterMessageId: 'message-before' },
    )

    assert.deepStrictEqual(
      result.initialContext?.map(({ content }) => content.text),
      ['Missed one.', 'Missed two.'],
    )
  }),
)

it.effect('uses parent history for a top-level message whose reply thread has a different ID', () =>
  Effect.gen(function* () {
    const { fetches } = yield* load(
      {
        binding: {
          ...binding,
          conversationId: decodeConversationId('discord:guild-1:channel-1:reply-thread-9'),
        },
        message: trigger,
        discordHistorySource: 'channel',
      },
      [message('earlier-1', 'Parent discussion.')],
    )

    assert.strictEqual(fetches[0]?.threadId, 'discord:guild-1:channel-1:channel-1')
  }),
)

it.effect('uses exact thread history for a message received inside a real thread', () =>
  Effect.gen(function* () {
    const { fetches } = yield* load({ binding, message: trigger, discordHistorySource: 'thread' }, [
      message('earlier-1', 'Thread discussion.'),
    ])

    assert.strictEqual(fetches[0]?.threadId, 'discord:guild-1:channel-1:thread-1')
  }),
)

it.effect('uses channel history for channel-sentinel mode', () =>
  Effect.gen(function* () {
    const { fetches } = yield* load(
      {
        binding: {
          ...binding,
          conversationId: decodeConversationId('discord:guild-1:channel-1:channel-1'),
        },
        message: trigger,
        discordHistorySource: 'channel',
      },
      [message('earlier-1', 'Channel discussion.')],
    )

    assert.strictEqual(fetches[0]?.threadId, 'discord:guild-1:channel-1:channel-1')
  }),
)
